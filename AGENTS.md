# Collaboration Rules

## 測試強制條款
1. 新功能必須附上對應的 unit + integration 測試，缺一不可 merge。
2. Bug 修復必須先新增可重現失敗測試，再提交修復使測試轉綠。
3. 行為變更必須同步更新測試與文件，不允許保留紅測試。
4. UI 互動變更必須補 desktop + mobile 測試；至少 integration，關鍵流程需 e2e。
5. 每個切片 commit 前執行最小驗證命令；PR 前必須執行 `pnpm check`。
6. CDP viewport 驗證屬於人工補強，不可替代 automated tests。
