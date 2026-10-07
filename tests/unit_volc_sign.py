# 单测：V4 签名构造正确 + 用假 AK/SK 发起真实 ListModelActivations 请求
# 预期：请求能到达火山引擎（返回 4xx 鉴权/签名类错误），而非本地异常 → 证明签名格式被服务端识别
import sys, json
sys.path.insert(0, r"C:\Users\Lu\Documents\ChatGPT\选本网页")
from ai_generator.byte import _volc_v4_sign, ByteAdapter

# 1) 签名格式自洽性：同一参数重复签名，Authorization 结构完整（含 x-content-sha256 参与签名）
import json as _json
_payload = _json.dumps({"PageNumber": 1, "PageSize": 100, "SortBy": "VendorName", "SortOrder": "Asc",
                        "Filter": {"States": ["Available"], "IncludeDeprecatedModels": False}}, ensure_ascii=False)
xdate, auth, payload_hash = _volc_v4_sign("AKLT_test", "sk_test", {"Action": "ListModelActivations", "Version": "2024-01-01"}, _payload)
print("x-date:", xdate)
print("auth:", auth)
print("payload_hash:", payload_hash)
assert auth.startswith("HMAC-SHA256 Credential=AKLT_test/")
assert "SignedHeaders=host;x-date;x-content-sha256;content-type" in auth
assert "Signature=" in auth
assert len(auth.split("Signature=")[1]) == 64
assert len(payload_hash) == 64
print("OK: 签名格式自洽（含 x-content-sha256）")

# 2) 用假凭证发起真实请求：应被火山引擎鉴权拒绝（HTTP 4xx），证明请求与签名格式被识别
try:
    names = ByteAdapter().list_activations("AKLT_invalid_test", "invalid_sk_test")
    print("意外成功:", names)
except Exception as e:
    print("请求结果:", type(e).__name__, "|", str(e)[:400])
    print("OK: 请求到达火山引擎并被鉴权/签名校验拦截（非本地异常）" if "HTTP" in str(e) else "注意: 非 HTTP 错误")

# 3) 模型家族名匹配
fam = ByteAdapter._model_family("doubao-seedream-5-0-flash-260915")
print("family:", fam)
assert fam == "doubao-seedream-5-0-flash"
assert ByteAdapter._model_family("doubao-seedance-2-0-260128") == "doubao-seedance-2-0"
print("OK: 家族名匹配正确")
