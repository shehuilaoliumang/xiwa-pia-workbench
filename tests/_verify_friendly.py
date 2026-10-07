# -*- coding: utf-8 -*-
"""验证 friendly_error 翻译器（覆盖用户遇到的各类报错）。"""
import sys
from pathlib import Path
sys.path.insert(0, r"C:\Users\Lu\Documents\ChatGPT\选本网页")
from ai_generator.base import friendly_error

samples = [
    # 用户当前报错
    ('字节平台请求失败（403）：{"error":{"code":"AccountOverdueError","message":"The request failed '
     'because your account has an overdue balance. Request id: 0217913482749653a391e43edef5299850de6066b8d72e25e4991",'
     '"param":"","type":"Forbidden"}}（已尝试模型：doubao-seedance-1-0-pro-fast-251015）'),
    # 模型未开通
    ('字节平台请求失败（404）：{"error":{"code":"InvalidEndpointOrModel.NotFound","message":"The model or endpoint '
     'doubao-seedream-3-0-t2i-250415 does not exist or you do not have access to it.","param":"","type":"Not Found"}}'),
    # 429 安全体验模式
    ('字节平台请求失败（429）：{"error":{"code":"SetLimitExceeded","message":"Your account [2132677206] has reached '
     'the set usage limit for the [doubao-seedream-5-0-flash] model, and the model service has been paused."}}'),
    # 签名不匹配
    ('查询失败：开通状态查询失败（HTTP 401）：{"ResponseMetadata":{"Error":{"CodeN":100010,"Code":"SignatureDoesNotMatch",'
     '"Message":"The request signature we calculated does not match the signature you provided"}}}'),
    # 缺少 content
    ('字节平台请求失败（400）：{"error":{"code":"MissingParameter","message":"The request failed because it is missing '
     '`content` parameter.","param":"content","type":"BadRequest"}}（已尝试模型：doubao-seedream-5-0-flash-260915）'),
    # 模型不支持
    ('字节平台请求失败（400）：{"error":{"code":"InvalidParameter","message":"The parameter `model` specified in the request '
     'is not valid: the specified model doubao-seedream-5-0-flash does not support content generation."}}（已尝试模型：doubao-seedream-5-0-flash-260915）'),
    # 阿里 url error
    ('阿里平台请求失败（400）：{"request_id":"b46f3d95","code":"InvalidParameter","message":"url error, please check url！ For details, see: https://h."}'),
    # 未识别（保留原样）
    ('字节平台请求失败（500）：{"error":{"code":"InternalError","message":"something went wrong","type":"Server"}}'),
]

for i, sample in enumerate(samples):
    out = friendly_error(sample)
    print(f"--- 样例 {i+1} ---")
    print(out)
    print()
