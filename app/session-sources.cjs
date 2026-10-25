/* S04b 获准目录中的只读会话适配。
   读取器不签发或释放许可，只依赖调用方传入的读取许可，并在开始时与返回前
   通过权限服务校验。这里不发模型请求、不写记忆、不执行记录中的文本。
   路径先由权限服务解析；打开后再核对普通文件与 dev/ino，异常不返回部分正文。
   本机恶意进程的 TOCTOU 无法仅靠 Node 彻底消除，正式读取层仍需自行核验。 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const { getAdapter } = require("./session-source-adapters.cjs");

const LIMITS = Object.freeze({
  maxCandidates: 500,
  maxEntries: 2000,
  maxDepth: 4,
  tailBytes: 512 * 1024,
  maxMessages: 40,
  maxMessageChars: 4000,
  maxTextChars: 16000,
});

const UNSUPPORTED_FILE = /\.(zip|gz|tgz|tar|db|sqlite3?|bin|png|jpe?g|gif|webp|pdf)$/i;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function isWithin(base, target) {
  return target === base || target.startsWith(base + path.sep);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createSessionSourceReader({ permissions } = {}) {
  if (
    !permissions ||
    typeof permissions.validateReadPermit !== "function" ||
    typeof permissions.resolveAuthorizedFile !== "function"
  ) {
    throw new AppError("PERMISSIONS_REQUIRED", "会话读取器需要权限服务。");
  }

  function adapterFor(snapshot) {
    const adapter = getAdapter(snapshot.provider);
    if (!adapter) {
      throw new AppError("UNSUPPORTED_PROVIDER", "暂不支持该来源的会话格式。");
    }
    return adapter;
  }

  function sourcePathOf(canonicalRoot, resolvedPath) {
    return path.relative(canonicalRoot, resolvedPath).split(path.sep).join("/");
  }

  function fileKeyOf(snapshot, sourcePath) {
    return `${snapshot.provider}:${sha256Text(snapshot.canonicalPath).slice(0, 32)}:${sourcePath}`;
  }

  function sessionPath(permit, relativePath) {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new AppError("INVALID_INPUT", "会话相对路径必须是字符串。");
    }
    const snapshot = permissions.validateReadPermit(permit);
    const adapter = adapterFor(snapshot);
    const resolved = permissions.resolveAuthorizedFile(permit, relativePath);
    const sourcePath = sourcePathOf(snapshot.canonicalPath, resolved);
    if (!adapter.matchesFile(sourcePath)) {
      if (UNSUPPORTED_FILE.test(sourcePath)) {
        throw new AppError("UNSUPPORTED_FORMAT", "暂不支持压缩归档、附件或二进制文件。");
      }
      throw new AppError("NOT_SESSION_FILE", "该文件不是受支持的会话记录。");
    }
    return { snapshot, adapter, resolved, sourcePath };
  }

  function directoryError(error) {
    if (error instanceof AppError) {
      return error;
    }
    if (error.code === "ENOENT") {
      return new AppError("SOURCE_UNAVAILABLE", "来源目录已不存在。");
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      return new AppError("SOURCE_INACCESSIBLE", "来源目录当前不可访问。");
    }
    return new AppError("SOURCE_UNAVAILABLE", "无法枚举来源目录。");
  }

  function fileError(error) {
    if (error instanceof AppError) {
      return error;
    }
    if (error.code === "ENOENT") {
      return new AppError("FILE_NOT_FOUND", "会话文件已不存在。");
    }
    if (error.code === "ELOOP") {
      return new AppError("FILE_CHANGED", "会话文件路径已变化。");
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      return new AppError("SOURCE_INACCESSIBLE", "会话文件当前不可访问。");
    }
    return new AppError("READ_FAILED", "读取会话文件失败。");
  }

  /* 只枚举显式授权根内、适配器支持的会话文件。opendir 逐条迭代，不一次载入
     整个目录；所有条目共享总访问预算。跳过软链，进入子目录前重新核实其为
     非软链且仍在授权根内。达到任一限制时 truncated 为 true。 */
  function listSessionFiles(permit) {
    const snapshot = permissions.validateReadPermit(permit);
    const adapter = adapterFor(snapshot);
    const files = [];
    let truncated = false;
    let stopped = false;
    let visits = 0;

    function walk(dir, relativeDir, level) {
      let handle;
      try {
        handle = fs.opendirSync(dir);
      } catch (error) {
        throw directoryError(error);
      }
      try {
        while (!stopped) {
          let entry;
          try {
            entry = handle.readSync();
          } catch (error) {
            throw directoryError(error);
          }
          if (!entry) {
            break;
          }
          visits += 1;
          if (visits > LIMITS.maxEntries) {
            truncated = true;
            stopped = true;
            break;
          }

          const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (level >= LIMITS.maxDepth) {
              truncated = true;
              continue;
            }
            let stat;
            let real;
            try {
              stat = fs.lstatSync(fullPath, { bigint: true });
              if (!stat.isDirectory() || stat.isSymbolicLink()) {
                continue;
              }
              real = fs.realpathSync(fullPath);
            } catch (error) {
              throw directoryError(error);
            }
            if (!isWithin(snapshot.canonicalPath, real)) {
              throw new AppError("SOURCE_CHANGED", "来源目录在枚举过程中发生变化。");
            }
            walk(fullPath, relativePath, level + 1);
            continue;
          }
          if (!entry.isFile() || !adapter.matchesFile(relativePath)) {
            continue;
          }
          if (files.length >= LIMITS.maxCandidates) {
            truncated = true;
            stopped = true;
            break;
          }
          let stat;
          try {
            stat = fs.lstatSync(fullPath);
          } catch (error) {
            if (error.code === "ENOENT") {
              truncated = true;
              continue;
            }
            throw directoryError(error);
          }
          if (!stat.isFile() || stat.isSymbolicLink()) {
            continue;
          }
          files.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      } finally {
        try {
          handle.closeSync();
        } catch {
          // 关闭失败不覆盖已确定的枚举结果或业务错误。
        }
      }
    }

    walk(snapshot.canonicalPath, "", 0);
    files.sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    // 返回前再次确认许可仍有效（例如枚举期间被撤销或关闭分析）。
    permissions.validateReadPermit(permit);
    return { provider: snapshot.provider, files, truncated };
  }

  function readAt(fd, position, length) {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
      if (read === 0) {
        throw new AppError("FILE_CHANGED", "会话文件在读取过程中发生变化。");
      }
      offset += read;
    }
    return buffer;
  }

  function verifyIdentity(resolvedPath, opened) {
    let current;
    try {
      current = fs.lstatSync(resolvedPath, { bigint: true });
    } catch {
      throw new AppError("FILE_CHANGED", "会话文件在读取过程中发生变化。");
    }
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new AppError("FILE_CHANGED", "会话文件在读取过程中发生变化。");
    }
  }

  function readWindow(fd, size, diagnostics) {
    if (size === 0) {
      return { bodyStart: 0, body: Buffer.alloc(0) };
    }
    if (size <= LIMITS.tailBytes) {
      return { bodyStart: 0, body: readAt(fd, 0, size) };
    }

    diagnostics.tailLimited = true;
    const bodyStart = size - LIMITS.tailBytes;
    const probe = readAt(fd, bodyStart - 1, 1);
    let body = readAt(fd, bodyStart, LIMITS.tailBytes);
    if (probe[0] !== 0x0a) {
      const newline = body.indexOf(0x0a);
      if (newline === -1) {
        // 整个窗口仍在同一条记录内，无法确认任何完整行。
        diagnostics.headTruncated = true;
        diagnostics.lineTooLarge = true;
        diagnostics.incompleteTail = true;
        return { bodyStart: 0, body: Buffer.alloc(0) };
      }
      diagnostics.headTruncated = true;
      body = body.subarray(newline + 1);
      return { bodyStart: bodyStart + newline + 1, body };
    }
    return { bodyStart, body };
  }

  /* 按字节偏移逐行处理，保证新增内容不改变旧消息的 offset 标识。
     只解析以换行结束的完整行；半行、坏行和无效 UTF-8 分别计诊断。 */
  function parseBody({ body, bodyStart }, adapter, snapshot, sourcePath, diagnostics) {
    const messages = [];
    const seenIds = new Set();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // 稳定规范来源摘要：隔离不同授权根，且不向输出暴露真实绝对路径。
    const rootId = crypto.createHash("sha256").update(snapshot.canonicalPath).digest("hex").slice(0, 32);
    let cursor = 0;
    while (cursor < body.length) {
      const newline = body.indexOf(0x0a, cursor);
      if (newline === -1) {
        diagnostics.incompleteTail = true;
        break;
      }
      const line = body.subarray(cursor, newline);
      const offset = bodyStart + cursor;
      cursor = newline + 1;
      if (line.length === 0) {
        continue;
      }

      let text;
      try {
        text = decoder.decode(line);
      } catch {
        diagnostics.invalidEncodingLines += 1;
        continue;
      }
      if (offset === 0 && text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      if (text.endsWith("\r")) {
        text = text.slice(0, -1);
      }
      if (text.trim() === "") {
        continue;
      }

      let record;
      try {
        record = JSON.parse(text);
      } catch {
        diagnostics.malformedLines += 1;
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        diagnostics.malformedLines += 1;
        continue;
      }

      const extracted = adapter.extract(record);
      if (!extracted) {
        continue;
      }
      if (extracted.unsupported) {
        diagnostics.unsupportedRecords += 1;
        continue;
      }
      if (extracted.ignored) {
        diagnostics.ignoredRecords += 1;
        continue;
      }

      let sourceId;
      if (extracted.id) {
        if (seenIds.has(extracted.id)) {
          continue;
        }
        seenIds.add(extracted.id);
        sourceId = `${snapshot.provider}:${rootId}:${sourcePath}:id:${extracted.id}`;
      } else {
        sourceId = `${snapshot.provider}:${rootId}:${sourcePath}:offset:${offset}`;
      }
      messages.push({
        sourceId,
        provider: snapshot.provider,
        role: extracted.role,
        text: extracted.text,
        timestamp: extracted.timestamp ?? null,
        sourcePath,
        truncated: false,
      });
    }
    return messages;
  }

  /* 先保留最近 40 条，再限制单条与总字符数；超出时显式标记 truncated。 */
  function limitMessages(messages, diagnostics) {
    let kept = messages;
    let truncated = false;
    if (kept.length > LIMITS.maxMessages) {
      diagnostics.droppedMessages += kept.length - LIMITS.maxMessages;
      kept = kept.slice(-LIMITS.maxMessages);
      truncated = true;
    }
    for (const message of kept) {
      const chars = Array.from(message.text);
      if (chars.length > LIMITS.maxMessageChars) {
        message.text = chars.slice(0, LIMITS.maxMessageChars).join("");
        message.truncated = true;
        diagnostics.truncatedMessages += 1;
        truncated = true;
      }
    }
    let total = 0;
    let start = kept.length;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const length = Array.from(kept[index].text).length;
      if (total + length > LIMITS.maxTextChars) {
        diagnostics.droppedMessages += index + 1;
        start = index + 1;
        truncated = true;
        break;
      }
      total += length;
      start = index;
    }
    return { messages: start > 0 ? kept.slice(start) : kept, truncated };
  }

  function readSession(permit, relativePath) {
    const { snapshot, adapter, resolved, sourcePath } = sessionPath(permit, relativePath);

    let fd;
    try {
      let before;
      try {
        before = fs.lstatSync(resolved, { bigint: true });
      } catch (error) {
        throw fileError(error);
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new AppError("FILE_CHANGED", "会话文件路径已变化。");
      }
      try {
        fd = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW);
      } catch (error) {
        throw fileError(error);
      }
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new AppError("FILE_CHANGED", "会话文件在读取过程中发生变化。");
      }

      const diagnostics = {
        headTruncated: false,
        incompleteTail: false,
        tailLimited: false,
        lineTooLarge: false,
        malformedLines: 0,
        invalidEncodingLines: 0,
        unsupportedRecords: 0,
        ignoredRecords: 0,
        truncatedMessages: 0,
        droppedMessages: 0,
        appendedDuringRead: false,
      };
      const size = Number(opened.size);
      const window = readWindow(fd, size, diagnostics);
      const parsed = parseBody(window, adapter, snapshot, sourcePath, diagnostics);
      const limited = limitMessages(parsed, diagnostics);
      const truncated =
        limited.truncated ||
        diagnostics.headTruncated ||
        diagnostics.incompleteTail ||
        diagnostics.tailLimited ||
        diagnostics.lineTooLarge;

      // 发布前重新解析 relativePath 并核对身份；路径改向、截断或原地改写时
      // 不返回已解析的部分正文。普通追加只返回原快照并显式标记。
      const finalResolved = permissions.resolveAuthorizedFile(permit, relativePath);
      if (finalResolved !== resolved) {
        throw new AppError("FILE_CHANGED", "会话文件路径在读取过程中发生变化。");
      }
      verifyIdentity(finalResolved, opened);
      let finalStat;
      try {
        finalStat = fs.fstatSync(fd, { bigint: true });
      } catch {
        throw new AppError("FILE_CHANGED", "会话文件在读取过程中发生变化。");
      }
      const finalSize = Number(finalStat.size);
      if (finalSize < size) {
        throw new AppError("FILE_CHANGED", "会话文件在读取过程中被截断。");
      }
      if (window.body.length > 0) {
        const recheck = readAt(fd, window.bodyStart, window.body.length);
        if (!recheck.equals(window.body)) {
          throw new AppError("FILE_CHANGED", "会话文件在读取过程中被改写。");
        }
      }
      diagnostics.appendedDuringRead = finalSize > size;
      const checkpoint = {
        fileKey: fileKeyOf(snapshot, sourcePath),
        bodyStart: window.bodyStart,
        byteLength: window.body.length,
        regionSha256: sha256Buffer(window.body),
        dev: String(opened.dev),
        ino: String(opened.ino),
        snapshotBytes: size,
      };
      return {
        provider: snapshot.provider,
        relativePath: sourcePath,
        messages: limited.messages,
        diagnostics,
        truncated,
        snapshotBytes: size,
        checkpoint,
      };
    } catch (error) {
      throw fileError(error);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // 关闭失败不覆盖已确定的读取结果或业务错误。
        }
      }
    }
  }

  function fileKey(permit, relativePath) {
    const { snapshot, sourcePath } = sessionPath(permit, relativePath);
    return {
      fileKey: fileKeyOf(snapshot, sourcePath),
      provider: snapshot.provider,
      relativePath: sourcePath,
    };
  }

  function validCheckpoint(checkpoint) {
    if (!checkpoint || typeof checkpoint !== "object") {
      return false;
    }
    const {
      fileKey: key,
      bodyStart,
      byteLength,
      regionSha256,
      dev,
      ino,
      snapshotBytes,
    } = checkpoint;
    return (
      typeof key === "string" &&
      key.length > 0 &&
      Number.isSafeInteger(bodyStart) &&
      bodyStart >= 0 &&
      Number.isSafeInteger(byteLength) &&
      byteLength >= 0 &&
      byteLength <= LIMITS.tailBytes &&
      Number.isSafeInteger(bodyStart + byteLength) &&
      Number.isSafeInteger(snapshotBytes) &&
      snapshotBytes >= bodyStart + byteLength &&
      typeof regionSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(regionSha256) &&
      typeof dev === "string" &&
      dev.length > 0 &&
      typeof ino === "string" &&
      ino.length > 0
    );
  }

  /* 只校验有界历史/本次读取区段，不返回正文。前插、改写、截断、替换或
     路径改向返回 verified:false；授权/打开失败则抛业务错误，不能当通过。 */
  function verifyCheckpoint(permit, relativePath, checkpoint) {
    const { snapshot, resolved, sourcePath } = sessionPath(permit, relativePath);
    const expectedKey = fileKeyOf(snapshot, sourcePath);
    if (!validCheckpoint(checkpoint)) {
      return { verified: false, reason: "CHECKPOINT_INVALID" };
    }
    if (checkpoint.fileKey !== expectedKey) {
      return { verified: false, reason: "CHECKPOINT_MISMATCH" };
    }

    let fd;
    try {
      let before;
      try {
        before = fs.lstatSync(resolved, { bigint: true });
      } catch (error) {
        throw fileError(error);
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        return { verified: false, reason: "FILE_CHANGED" };
      }
      try {
        fd = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW);
      } catch (error) {
        throw fileError(error);
      }
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        return { verified: false, reason: "FILE_CHANGED" };
      }
      if (String(opened.dev) !== checkpoint.dev || String(opened.ino) !== checkpoint.ino) {
        return { verified: false, reason: "FILE_REPLACED" };
      }

      const size = Number(opened.size);
      if (checkpoint.bodyStart + checkpoint.byteLength > size) {
        return { verified: false, reason: "REGION_CHANGED" };
      }
      let bytes;
      try {
        bytes = readAt(fd, checkpoint.bodyStart, checkpoint.byteLength);
      } catch (error) {
        if (error?.code === "FILE_CHANGED") {
          return { verified: false, reason: "REGION_CHANGED" };
        }
        throw error;
      }
      if (sha256Buffer(bytes) !== checkpoint.regionSha256) {
        return { verified: false, reason: "REGION_CHANGED" };
      }

      const finalResolved = permissions.resolveAuthorizedFile(permit, relativePath);
      if (finalResolved !== resolved) {
        return { verified: false, reason: "PATH_CHANGED" };
      }
      try {
        verifyIdentity(finalResolved, opened);
      } catch (error) {
        if (error?.code === "FILE_CHANGED") {
          return { verified: false, reason: "FILE_CHANGED" };
        }
        throw error;
      }
      permissions.validateReadPermit(permit);
      return { verified: true };
    } catch (error) {
      throw fileError(error);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // 关闭失败不覆盖校验结果。
        }
      }
    }
  }

  return { listSessionFiles, readSession, fileKey, verifyCheckpoint };
}

module.exports = { createSessionSourceReader };
