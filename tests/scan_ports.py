import socket, json, urllib.request
ports = [1024,1060,1091,1759,3075,4001,4301,4310,5040,5283,5284,7680,7890,8878,8901,9210,9222,9410,11200,14013,14016,14019,14022,14023,14120,14450,14451,14458,14459,16422,22331,24843,42050,42064,45406,8765,8766,8770,8888,8890]
for p in ports:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{p}/api/health", timeout=1.2) as r:
            data = json.load(r)
            print(f"{p}: {data}")
    except Exception as e:
        pass
print("scan done")
