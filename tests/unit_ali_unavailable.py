# 单测：阿里「模型未开通」报错识别（InvalidParameter + url error）→ 记录 unavailable 并切换模型
import sys
sys.path.insert(0, r"C:\Users\Lu\Documents\ChatGPT\选本网页")
from ai_generator.tasks import TaskManager

ali_err = ('阿里平台请求失败（400）：{"request_id":"b46f3d95","code":"InvalidParameter",'
           '"message":"url error, please check url！ For details, see: https://help.aliyun.com/zh/model-studio"}')
byte_err = ('字节平台请求失败（404）：{"error":{"code":"InvalidEndpointOrModel.NotFound",'
            '"message":"The model or endpoint doubao-seedream-3-0-t2i-250415 does not exist or you do not have access to it."}}')
other_err = "阿里平台请求失败（400）：配额不足，请充值。"
other2_err = "阿里平台请求失败（400）：参数错误，prompt 不能为空。"

checks = [
    (ali_err, True, "阿里 url error → 应判定为模型不可用"),
    (byte_err, True, "字节 404 → 应判定为模型不可用"),
    (other_err, False, "配额错误 → 不应判定为模型不可用（不切换模型）"),
    (other2_err, False, "参数错误 → 不应判定为模型不可用"),
]
ok = True
for text, expected, label in checks:
    got = TaskManager._is_model_unavailable(text)
    flag = "PASS" if got == expected else "FAIL"
    if got != expected:
        ok = False
    print(f"[{flag}] {label}: got={got} expected={expected}")
print("ALL PASS" if ok else "SOME FAILED")
raise SystemExit(0 if ok else 1)
