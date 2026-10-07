// 验证：①保留测试剧本创建 ②角色形象图生成链路（mock） ③模型列表刷新接口
const BASE = "http://127.0.0.1:8765";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const j = (r) => r.json();

  // ① 创建保留测试剧本（供用户人工测试）
  const created = await (await fetch(BASE + "/api/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ title: "人工测试剧本", category_id: "cat-sweet", blocks: [
      { kind: "text", text: "第一段：这里是测试剧本的开场台词。", role: "旁白", color: "#343b37" },
      { kind: "text", text: "第二段：主角登场，说出第一句对白。", role: "主角", color: "#343b37" },
      { kind: "text", text: "第三段：插入音视频测试段落的位置。", role: "主角", color: "#343b37" },
      { kind: "text", text: "第四段：结尾台词，测试结束。", role: "旁白", color: "#343b37" },
    ], visible: true }),
  })).json();
  console.log("① 保留测试剧本:", created.id, "| 段落:", created.blocks.length);

  // ② 角色形象图生成：先建一个角色 → mock 生成形象图 → 轮询任务
  const character = await (await fetch(BASE + "/api/ai/characters", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ name: "测试角色·阿福", description: "测试用角色形象，圆脸短发，暖色毛衣" }),
  })).json();
  console.log("② 角色:", character.id);
  const gen = await (await fetch(BASE + "/api/ai/characters/" + character.id + "/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ prompt: "", platform: "mock", model: "", ratio: "1:1" }),
  })).json();
  console.log("   mock 形象图任务:", gen.status, gen.progress, "%");
  // 等待任务完成（mock 1.2s + 轮询）
  let task = gen;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    task = await (await fetch(BASE + "/api/ai/tasks/" + gen.task_id)).json();
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") break;
  }
  console.log("   完成:", task.status, "| 进度", task.progress, "| 文件:", (task.result_file || "").split(/[\\/]/).pop());

  // ③ 模型列表刷新接口
  const refresh = await (await fetch(BASE + "/api/ai/models/refresh", {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  })).json();
  const plat = refresh.platforms || {};
  console.log("③ 刷新模型: refreshed=", refresh.refreshed);
  for (const p of ["byte", "ali", "mock"]) {
    const info = plat[p] || {};
    console.log("   ", p, "视频模型:", Object.keys(info.models || {}).length, "项 →", Object.keys(info.models || {}).slice(0, 4).join(" | ") || "(内置默认)");
  }
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
