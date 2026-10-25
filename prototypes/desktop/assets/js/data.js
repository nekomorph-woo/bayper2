/* 原型数据：角色、记忆、故事、Herdr 来源与通知、设置默认值。
   全部为构造内容。名称、用户、事件与数值都是模拟，不含真实个人信息。

   记忆按 PRD：偏好写的是「你」的事，来源是「某人告诉某位角色」；
   角色自己的习惯放在概览，不混进记忆。共享偏好带同一个 key，
   纠正时只同步已持有同一理解的角色。 */

window.BAYPER = {
  versionLabel: "交互原型 · 2026.10",

  /* ---------- 角色 ---------- */

  characters: {
    rin: {
      id: "rin",
      name: "凛",
      img: "assets/img/rin.png",
      shape: "full",
      tagline: "听得比说得多",
      intro: "黑猫耳的住客。她不太抢话，常把窗边那张椅子留给你，自己坐在桌角。",
      traits: ["回答问题前会先停一下", "茶要放到温热才喝", "织东西的时候不太理人，但会留一盏灯"],
      habit: "下午三点左右会去窗边坐一会儿。",
      today: "毛线织到一半，她说等光挪过来再继续。",
      stats: {
        intimacy: { value: 46, label: "渐渐熟悉" },
        energy: { value: 78, label: "精力充足" },
        mood: { value: 1, label: "心情平静" },
      },
    },
    hu: {
      id: "hu",
      name: "琥珀",
      img: "assets/img/hu.png",
      shape: "bust",
      tagline: "出门前一定会说一声",
      intro: "琥珀坐不住。她把小窝当出发点，出门转一圈，回来时兜里总有点什么。",
      traits: ["走路快，说话也快", "喜欢收集石头和旧票据", "不喜欢被人安排行程"],
      habit: "天晴的时候会沿河道走很远。",
      today: "刚进门，兜里揣着在河边捡的灰色石头。",
      stats: {
        intimacy: { value: 33, label: "正在熟悉" },
        energy: { value: 52, label: "有点疲倦" },
        mood: { value: 1, label: "心情不错" },
      },
    },
    cheng: {
      id: "cheng",
      name: "澄",
      img: "assets/img/cheng.png",
      shape: "bust",
      tagline: "醒着的时候很安静",
      intro: "澄多半待在小窝里。她把毯子叠得很整齐，然后坐在上面发呆。",
      traits: ["喜欢靠窗的软垫", "睡着的时候会说梦话", "对陌生人先观察三天"],
      habit: "午后会靠在窗边打盹。",
      today: "毯子叠好了，她坐在窗边打盹。",
      stats: {
        intimacy: { value: 28, label: "正在熟悉" },
        energy: { value: 88, label: "精力充足" },
        mood: { value: 2, label: "心情很好" },
      },
    },
    aya: {
      id: "aya",
      name: "绫",
      img: null,
      shape: "none",
      tagline: "还没有见过面",
      intro: "她在故事里留了一封邀请，住在河对岸。接纳之后才会出现在角色册和小窝里。",
      traits: ["只在信里说过话", "字写得很小", "喜欢傍晚出门"],
      habit: "还没有一起待过，说不上习惯。",
      today: "",
      stats: null,
    },
  },

  order: ["rin", "hu", "cheng"],

  statusText: {
    desktop: "正在桌面",
    exploring: "探索中",
    home: "在小窝休息",
    unknown: "状态未知",
  },

  /* ---------- 记忆 ---------- */

  memories: {
    rin: [
      {
        id: "rin-tea",
        key: "tea",
        kind: "preference",
        text: "你更喜欢温一点的茶，太烫的会先放一会儿",
        source: "你告诉凛",
        date: "10月12日",
      },
      {
        id: "rin-interrupt",
        key: "interrupt",
        kind: "preference",
        text: "你不想在工作时被频繁打断，重要的事留到你停手再说",
        source: "你告诉凛",
        date: "10月18日",
      },
      {
        id: "rin-rain",
        key: "rain",
        kind: "experience",
        text: "下雨那天三个人挤在窗边看雨，谁都没说话",
        source: "共同经历",
        date: "10月3日",
      },
      {
        id: "rin-relay",
        key: "relay-river",
        kind: "relay",
        text: "听琥珀说，河道尽头那排矮树今年落得早",
        source: "听琥珀说",
        date: "10月21日",
      },
    ],
    hu: [
      {
        id: "hu-coat",
        key: "coat",
        kind: "preference",
        text: "你不喜欢别人替你收外套，宁可自己挂回去",
        source: "你告诉琥珀",
        date: "10月9日",
      },
      {
        id: "hu-coffee",
        key: "coffee",
        kind: "preference",
        text: "你喝咖啡会加一点盐，说这样不苦",
        source: "你告诉琥珀",
        date: "10月15日",
      },
      {
        id: "hu-river",
        key: "river",
        kind: "experience",
        text: "一起走到河道尽头，回来的时候天已经黑了",
        source: "共同经历",
        date: "10月19日",
      },
      {
        id: "hu-relay",
        key: "relay-light",
        kind: "relay",
        text: "听凛说，窗边那盏灯是你留的",
        source: "听凛说",
        date: "10月22日",
      },
    ],
    cheng: [
      {
        id: "cheng-tea",
        key: "tea",
        kind: "preference",
        text: "你更喜欢温一点的茶，太烫的会先放一会儿",
        source: "凛告诉你 · 你同意过",
        date: "10月12日",
      },
      {
        id: "cheng-wake",
        key: "wake",
        kind: "preference",
        text: "你午睡时不想被叫醒，醒了会自己出来",
        source: "你告诉澄",
        date: "10月7日",
      },
      {
        id: "cheng-rain",
        key: "rain",
        kind: "experience",
        text: "下雨那天三个人挤在窗边看雨，谁都没说话",
        source: "共同经历",
        date: "10月3日",
      },
      {
        id: "cheng-relay",
        key: "relay-fog",
        kind: "relay",
        text: "听琥珀说，河边今天起雾了，对面看不清",
        source: "听琥珀说",
        date: "10月20日",
      },
    ],
  },

  memoryKind: {
    preference: "偏好",
    experience: "共同经历",
    relay: "转述",
  },

  /* ---------- 故事 ---------- */

  stories: [
    {
      id: "window-light",
      title: "窗边的光",
      date: "10月24日",
      who: "rin",
      place: "小窝 · 窗边",
      excerpt: "她先把椅子挪到光里，然后就不动了。",
      body: [
        "下午四点前后，光会从窗框斜进来，正好落在桌角。凛先在窗边站了一会儿，然后弯腰把椅子挪过去，挪了两下才停。",
        "她没有坐下，只是把手搭在椅背上，看着那块光慢慢往回收。我站在门口，她回头看了一眼，没有催我过去。",
        "后来光移走了，椅子还留在原来的位置。她说，明天这个时候还会照进来。",
      ],
    },
    {
      id: "aya-letter",
      title: "河对岸的邀请",
      date: "10月23日",
      who: "aya",
      invite: true,
      place: "故事 · 一封来信",
      excerpt: "信上说她住在河对岸，问能不能来小窝坐坐。",
      body: [
        "信封是从门缝底下进来的，没有邮戳。里面只有一张纸，字写得很小。",
        "她说自己住在河对岸，见过我们在河道尽头停下，也见过窗边那盏灯。她问，能不能来小窝坐一个下午。",
        "信的末尾没有留地址，只写了名字：绫。",
      ],
    },
    {
      id: "river-end",
      title: "河道的尽头",
      date: "10月19日",
      who: "hu",
      place: "河边 · 步道",
      excerpt: "琥珀说再往前走一段就到头了，结果走了很久。",
      body: [
        "琥珀出门前照例数了一遍口袋：钥匙、零钱、一张折过的旧票。她说少一样都不走。",
        "我们沿着河道往南，她说尽头有一排矮树，夏天的时候很凉快。走了很久，尽头比想象中远。",
        "回来的时候天已经黑了。她在门口站了一会儿，说明天再走一次，要赶在太阳落山之前。",
      ],
    },
    {
      id: "blanket",
      title: "毯子叠成方块",
      date: "10月11日",
      who: "cheng",
      place: "小窝 · 靠窗软垫",
      excerpt: "澄把毯子叠好，放在软垫正中间，然后坐了上去。",
      body: [
        "澄叠东西很有耐心。毯子要先对折，再对折，边角对齐了才停下，然后放在软垫正中间。",
        "她坐上去的时候动作很轻，像是怕把刚叠好的形状坐散。",
        "窗外有人在搬东西，她听了一会儿，问我要不要去看看。这是她今天说的第一句话。",
      ],
    },
    {
      id: "linen-apron",
      title: "旧围裙",
      date: "10月8日",
      who: "rin",
      place: "小窝 · 储物柜",
      excerpt: "柜子最里面挂着一件洗得发白的围裙，她说等秋天再穿。",
      body: [
        "整理柜子的时候翻出一件旧围裙，边角磨得有点毛。凛把它抖开看了看，说这是去年秋天一直穿的那件。",
        "她把它重新挂回去，说现在还不到时候。等叶子再落一些，她会把它换上。",
        "这套衣服目前只有这一件实物，暂时没有第二套可以换。故事讲的是它的来历，读完不会自动解锁什么。",
      ],
    },
  ],

  /* ---------- 连接 ---------- */

  sources: [
    {
      id: "local",
      name: "本机的 Herdr",
      place: "这台电脑",
      online: true,
      agents: [
        { name: "写周报", state: "working", note: "16:52 你确认了文件名，继续写" },
        { name: "整理照片", state: "waiting", note: "等你确认保存的位置" },
        { name: "备份脚本", state: "done", note: "13:50 结束" },
      ],
    },
    {
      id: "studio",
      name: "工作室的 Mac mini",
      place: "远端",
      online: false,
      agents: [
        { name: "素材归档", state: "unknown", note: "断开前：11:30 起等你选择目录" },
        { name: "图片导出", state: "unknown", note: "断开前：16:12 仍在进行" },
      ],
    },
  ],

  agentState: {
    working: "工作中",
    waiting: "待处理",
    done: "已结束",
    unknown: "未知",
  },

  /* 时间与状态互相对得上：16:40 需要处理后，16:52 有一条继续工作的记录。 */
  notifications: [
    {
      id: "n-1652",
      source: "local",
      agent: "写周报",
      kind: "update",
      time: "16:52",
      title: "确认了文件名，继续写",
      detail: "你选了「2026-10-第4周.md」，写周报接着往下写。",
    },
    {
      id: "n-1640",
      source: "local",
      agent: "写周报",
      kind: "attention",
      time: "16:40",
      title: "需要你确认一个文件名",
      detail: "写周报想把文件存成「2026-10-第4周.md」，也可以换一个名字。在你确认之前它会停在这里。",
    },
    {
      id: "n-1612",
      source: "studio",
      agent: "图片导出",
      kind: "alert",
      time: "16:12",
      title: "连接中断",
      detail: "工作室的 Mac mini 断开连接。中断时「图片导出」仍在进行，当前状态未知，不能当作已经结束。",
    },
    {
      id: "n-1505",
      source: "local",
      agent: "整理照片",
      kind: "attention",
      time: "15:05",
      title: "选好了 12 张，等你确认",
      detail: "整理照片把重复的挑了出来，剩下 12 张等你确认保存目录。",
    },
    {
      id: "n-1350",
      source: "local",
      agent: "备份脚本",
      kind: "done",
      time: "13:50",
      title: "已经结束",
      detail: "备份脚本在 13:50 跑完，结果放在原来的目录里。",
    },
    {
      id: "n-1130",
      source: "studio",
      agent: "素材归档",
      kind: "attention",
      time: "11:30",
      title: "需要选择归档目录",
      detail: "素材归档在等你选一个目录。没有选择之前它会一直等着，不会自己猜。",
    },
    {
      id: "n-0920",
      source: "studio",
      agent: "图片导出",
      kind: "done",
      time: "09:20",
      title: "已经结束",
      detail: "上一轮图片导出完成，这次共写了 34 个文件。",
    },
  ],

  /* ---------- 聊天预置回应 ---------- */

  chatPresets: {
    rin: [
      "嗯，我在。你先坐会儿，毛线还有一小截。",
      "今天的光不错。你那边忙完了吗？",
      "不着急说完整，我听着呢。",
    ],
    hu: [
      "我回来了，兜里有块石头，待会儿给你看。",
      "河道尽头今天有风，比昨天凉。",
      "出门前我数过口袋，一样没少。",
    ],
    cheng: [
      "你回来了。毯子我刚叠好。",
      "刚才窗外有响动，我去看了一眼，没什么事。",
      "要坐一会儿吗？这里晒得到太阳。",
    ],
    aya: [
      "等天气好一点，我就过来。",
      "河这边安静，晚上能听见水声。",
      "你写的那几句，我读了三遍。",
    ],
  },

  chatOpenings: {
    rin: "你回来啦。毛线放在窗台，我替你收好了。",
    hu: "我刚进门。今天走得有点远。",
    cheng: "你回来了。毯子我刚叠好。",
    aya: "信收到了吗？我还在河对岸。",
  },

  /* ---------- 设置 ---------- */

  settings: {
    model: {
      endpoint: "https://api.example.invalid/v1",
      model: "qwen2.5-14b-instruct",
    },
    desktop: {
      size: "m",
      autostart: false,
      pointer: true,
    },
    notify: {
      arrivals: true,
      stories: false,
    },
    rhythm: {
      paused: false,
      activities: [
        { id: "window", name: "在窗边坐一会儿", kind: "短日常", on: true },
        { id: "tidy", name: "收拾一下桌子", kind: "短日常", on: true },
        { id: "note", name: "留一张小纸条", kind: "短日常", on: false },
      ],
    },
    privacy: {
      analysis: false,
    },
  },

  /* 分析来源是 Coding Agent 的会话目录，不是普通文件夹。 */
  agentSources: [
    {
      id: "claude-code",
      name: "Claude Code",
      what: "会话记录",
      dirLabel: "claude-projects（模拟）",
    },
    {
      id: "codex",
      name: "Codex",
      what: "会话记录",
      dirLabel: "codex-sessions（模拟）",
    },
  ],

  demoDirectories: [
    { name: "claude-projects（模拟）", ok: true },
    { name: "codex-sessions（模拟）", ok: true },
    { name: "系统保留位置（模拟）", ok: false },
  ],
};
