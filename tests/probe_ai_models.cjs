// 查当前图像/视频模型列表
(async () => {
  const st = await (await fetch("http://127.0.0.1:8765/api/ai/status", { cache: "no-store" })).json();
  const p = (name) => {
    const cfg = st.platforms[name] || {};
    return {
      default: cfg.model || "",
      imageModels: Object.keys(cfg.image_models || {}),
      videoModels: Object.keys(cfg.models || {}),
    };
  };
  console.log("BYTE:", JSON.stringify(p("byte"), null, 1));
  console.log("ALI:", JSON.stringify(p("ali"), null, 1));
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
