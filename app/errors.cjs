/* 可预期的业务错误。渲染进程只看到 code 与中文 message，
   不接触内部异常、密钥或完整请求细节。 */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

function toPublicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL", message: "发生了未预期的错误，请重试。" };
}

module.exports = { AppError, toPublicError };
