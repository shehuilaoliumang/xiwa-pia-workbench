// 场面提示词 → mock 视频生成 → 插入测试剧本第 3 段后 → 验证
const BASE = "http://127.0.0.1:8765";
const SCRIPT = "script-e38349b24872";
const BLOCK = "block-7763c3e9b2e44432a7fe9c5bbc475933"; // 第 3 段
const PROMPT = "黄昏的老城街巷，斜阳把青石板路染成暖金色，细小的尘埃在光线里浮动。一位穿暖色毛衣、发梢微卷的年轻女子从巷口缓步走来，风轻轻吹动她的衣角；她停下脚步，抬头望向天边最后一抹晚霞，目光从疲惫转为坚定。镜头缓慢推近她的侧脸，背景隐约传来远处市集的人声。电影质感，浅景深，色调温暖柔和，画面干净有呼吸感。";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const task = await (await fetch(BASE + "/api/ai/video/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ prompt: PROMPT, platform: "mock", model: "", ratio: "9:16", duration: 5, script_id: SCRIPT, block_id: BLOCK, role_name: "", ref_image: null }),
  })).json();
  console.log("已提交任务:", task.task_id, "|", task.status);
  let current = task;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    current = await (await fetch(BASE + "/api/ai/tasks/" + task.task_id)).json();
    if (["succeeded", "failed", "cancelled"].includes(current.status)) break;
  }
  console.log("任务状态:", current.status, "| 进度:", current.progress, "| 错误:", current.error || "无");
  if (current.status === "succeeded") {
    const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
    const script = lib2.scripts.find((s) => s.id === SCRIPT);
    const seq = script.blocks.map((b, i) => (b.kind === "text" ? "text:" + (b.text || "").slice(0, 10) : b.kind + ":" + (b.media_name || "").slice(0, 18)));
    console.log("剧本段落序列:", JSON.stringify(seq));
  }
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
