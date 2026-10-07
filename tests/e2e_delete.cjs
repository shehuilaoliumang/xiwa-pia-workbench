// 端到端回归：临时剧本（引用共享视频）→ 隐藏 → 删除 → 共享媒体必须保留
const BASE = "http://127.0.0.1:8765";
const MP4 = "/media/0880f1a624369891671b84595b3291f01f4afef67a7afc67f5c85c18ec827cb1.mp4";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const before = lib.scripts.length;

  // 1) 创建临时剧本（引用爱情公寓共享视频段落）
  const created = await fetch(BASE + "/api/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({
      title: "临时删除测试",
      category_id: "cat-sweet",
      blocks: [{ kind: "video", media_path: MP4, media_name: "爱情公寓.mp4", text: "", role: "" }],
      visible: true,
    }),
  });
  const createdJson = await created.json();
  console.log("创建:", created.status, "| id:", createdJson.id, "| blocks:", createdJson.blocks.length);

  // 2) 隐藏
  await fetch(BASE + "/api/scripts/" + encodeURIComponent(createdJson.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ visible: false }),
  });
  console.log("已隐藏");

  // 3) 删除
  const del = await fetch(BASE + "/api/scripts/" + encodeURIComponent(createdJson.id), {
    method: "DELETE",
    headers: { "X-CSRF-Token": token },
  });
  const delJson = await del.json();
  console.log("删除:", del.status, "|", JSON.stringify(delJson));

  // 4) 验证：共享视频必须保留（爱情公寓仍在引用）
  const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  console.log("剧本数:", before, "->", lib2.scripts.length, "| 临时剧本已删:", !lib2.scripts.some((s) => s.title === "临时删除测试"));
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
