from api.utils import *
scope = "all"
base_df = DF
if len(base_df) == 0 and scope == "all":
    base_df = DF.copy()

base_df = ensure_sort_cols(base_df)

# 只取完整資料；若沒有完整的就退回全部
df_full = base_df[base_df["__complete"]] if "__complete" in base_df.columns else base_df
if len(df_full) == 0:
    df_full = base_df
df = df_full.sort_values(
    by=["__shape_sum"],
    ascending=[False],
    na_position="last",
    kind="mergesort",
)
# ids = ["PanTS_00003315", "PanTS_00005485"]
# print(df.loc[df["PanTS ID"].isin(ids)])
df = df.drop_duplicates(subset="shape", keep="first")
# n, k
try: n = int(request.args.get("n") or 3)
except Exception: n = 3
n = max(1, min(n, len(df)))

try: K = int(request.args.get("k") or 100)
except Exception: K = 100
K = max(n, min(K, len(df)))

# recent 排除
recent_raw = ""
used_recent = 0
if recent_raw:
    recent_ids = {s.strip() for s in recent_raw.split(",") if s.strip()}
    key = df["__case_str"].astype(str) if "__case_str" in df.columns else None
    if key is not None:
        mask = ~key.isin(recent_ids)
        used_recent = int((~mask).sum())
        df2 = df[mask]
        if len(df2): df = df2

topk = df.iloc[:K]

# off_arg = request.args.get("offset")
# if off_arg is not None:
#     try: offset = int(off_arg) % len(topk)
#     except Exception: offset = 0
# else:
#     now = datetime.utcnow()
#     offset = ((now.minute * 60) + now.second) % len(topk)

# idx = list(range(len(topk))) + list(range(len(topk)))
# pick = idx[offset:offset + min(n, len(topk))]
# sub = topk.iloc[pick]

items = [row_to_item(r) for _, r in topk.iterrows()]
