// 删除测试剧本：先隐藏 → 再删除（模拟 UI 流程）
const BASE = "http://127.0.0.1:8765";
(async () => {
  const lib = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  const token = lib.csrf_token;
  const test = lib.scripts.find((s) => s.title === "测试");
  if (!test) { console.log("测试剧本不存在（可能已删除）"); return; }
  console.log("测试剧本:", test.id, "| visible:", test.visible, "| blocks:", test.blocks.length);

  // 1) 隐藏
  const hid = await fetch(BASE + "/api/scripts/" + encodeURIComponent(test.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ visible: false }),
  });
  const hidJson = await hid.json();
  console.log("隐藏:", hid.status, "| visible now:", hidJson.visible, "| ok:", hid.ok);

  // 2) 未隐藏时删除应被拒绝（用另一个显示中的剧本验证服务端保护）
  const show = lib.scripts.find((s) => s.visible !== false && s.id !== test.id);
  if (show) {
    const denied = await fetch(BASE + "/api/scripts/" + encodeURIComponent(show.id), {
      method: "DELETE",
      headers: { "X-CSRF-Token": token },
    });
    const deniedJson = await denied.json().catch(() => ({}));
    console.log("保护校验(显示中剧本 " + show.title + " 删除应被拒):", denied.status, "|", deniedJson.error || "?");
  }

  // 3) 删除（已隐藏）
  const del = await fetch(BASE + "/api/scripts/" + encodeURIComponent(test.id), {
    method: "DELETE",
    headers: { "X-CSRF-Token": token },
  });
  const delJson = await del.json();
  console.log("删除:", del.status, "|", JSON.stringify(delJson));

  // 4) 验证库状态
  const lib2 = await (await fetch(BASE + "/api/library", { cache: "no-store" })).json();
  console.log("删除后剧本数:", lib2.scripts.length, "| 仍含测试:", lib2.scripts.some((s) => s.title === "测试"));
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
