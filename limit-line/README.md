# limit-line

Mod cho Claude Code (≥ 2.1.287): dòng hạn mức phía trên ô prompt, bảng `/usage-plus`, và bộ
chưng cất output Bash.

## Tính năng

**Band** (phía trên prompt):

```
5h █░░░░░ 13% 2h19m | wk ██░░░░ 34% T2 10:00 | ctx ░░░░░░ 7% ▲+18k | cache 90% | dist -142k   [+]
turn 4 req · in 61k (cache 55k · write 4k · new 2k) · out 2.3k · ~$0.42 · opus · ctx ▃▄▆█
```

- `5h` / `wk`: hạn mức 5 giờ và tuần, thời điểm reset, `!` khi dự báo sẽ cạn trước khi reset. Có toast ở 80% và 95%.
- `ctx`: mức đầy context; `▲+N` / `▼-N`: context đổi bao nhiêu trong turn vừa xong (đỏ nếu quá 10% cửa sổ).
- `cache N%`: tỉ lệ cache hit của turn vừa xong (xanh ≥ 80, vàng 50–79, đỏ < 50).
- `dist -N`: số ký tự distiller đã cắt trong phiên.
- `[+]` / `/limits detail`: dòng chi tiết turn (số request, token theo loại, chi phí API-equiv, model, biểu đồ ctx). Lựa chọn được nhớ giữa các phiên.
- Màn hình hẹp: bỏ `dist`, rồi `▲`, rồi `cache`, rồi thu gọn thanh.

**`/usage-plus`**: pane ba tab, phím `1` Session, `2` Week, `3` Month, `x` đóng (cần focus pane: click hoặc ctrl+x tab).
Token theo loại mỗi ngày, cache hit, tiền tiết kiệm nhờ cache, các lần cache bust kèm nguyên nhân
(sau /compact, hết TTL, đổi model, không rõ), phân bổ theo model và project, lịch sử hạn mức và
dự báo tuần, thống kê distiller. Mỗi lần mở sẽ chạy indexer (đọc tăng dần `~/.claude/projects`).

**Distiller** (hook trên Bash): output dài (≥ 8000 ký tự) được rút gọn còn ≤ 4000 trước khi Claude đọc;
bản đầy đủ luôn lưu ở `<project>/.claude/distill/` (tự thêm vào `.gitignore` của repo git).
Có bộ lọc riêng cho pytest (gom lỗi theo chữ ký, traceback đầu của mỗi nhóm), các log khác dùng
bộ lọc chung (đầu, cuối và mọi dòng lỗi).
- Lệnh thành công: output được thay sau khi chạy.
- Lệnh thất bại: core không cho rút gọn sau khi chạy, nên các lệnh khớp danh sách (pytest, `python *train*`,
  `docker logs`, `pip install`, make/ninja/cargo/npm build) được bọc **trước** khi chạy: output đầy đủ ghi ra file,
  in bản rút gọn, giữ đúng mã thoát. Vì vậy quy tắc permission sẽ thấy lệnh đã bọc.

## Lệnh

| Lệnh | Việc |
|---|---|
| `/limits` | Ẩn / hiện band |
| `/limits detail` | Bật / tắt dòng chi tiết turn |
| `/usage-plus` | Mở bảng usage (nếu trùng tên: `/usage-x`) |
| `/distill on` / `off` | Bật / tắt distiller (nhớ giữa các phiên) |
| `/distill stats` | Số lần, ký tự đã cắt theo loại, tỉ lệ đọc lại |
| `/distill last` | Đường dẫn log đầy đủ của lần gần nhất |

Muốn xem output gốc của một lệnh: thêm `NO_DISTILL=1` vào lệnh. Lệnh đọc file trong `.claude/distill/` không bị chưng cất.

## Dữ liệu

`~/.local/share/limit-line/`:

```
ledger/<ngày>.json        mỗi request trực tiếp (token, model, project; không có nội dung)
measure/<tháng>.json      các lần đọc hạn mức (thưa)
compact/<tháng>.json      các lần compact
distill/<tháng>.json      các lần chưng cất (kích thước, đường dẫn log)
index/state.json          vị trí đã đọc của từng file JSONL
index/days/<ngày>.json    tổng hợp theo ngày (giờ Asia/Bangkok)
```

Xóa dữ liệu: `rm -rf ~/.local/share/limit-line` (indexer sẽ đọc lại từ đầu lần sau),
và `rm -rf <project>/.claude/distill`. Đọc lại lịch sử từ đầu: `node scripts/indexer.mjs --rebuild`.

## Giới hạn đã biết

- Chi phí là **API-equiv** theo bảng giá trong `hooks/pricing.ts` (cập nhật 2026-09-25, cần xác nhận); với gói subscription đây không phải số tiền phải trả.
- Usage trực tiếp không tách cache write 5m/1h: band và ledger tính như 1h; indexer dùng số tách trong JSONL.
- Lời gọi advisor nằm trong `usage.iterations` của JSONL: indexer có tính, band và ledger trực tiếp thì không.
- Dấu compact và subagent trong JSONL chưa được xác minh trên dữ liệu thật (chưa có phiên nào như vậy).
- Ước tính "ngoài máy này" chỉ hiện khi có ít nhất 2 cửa sổ 5h đầy đủ trong ledger.
- Distiller mới có bộ lọc pytest và chung; cuda, docker, train để sau.
- Cần `node` ≥ 23.6 trong PATH của Claude Code (indexer và wrapper của distiller chạy file `.ts` trực tiếp).

## Phát triển

```
claude plugin validate --strict .     # manifest + module
claude plugin test .                  # test của engine
node --test tests/indexer.node.mjs    # test của indexer
npx -p typescript@5 tsc -p .          # kiểu (sau khi Claude Code đã sinh .claude-plugin/types)
node scripts/build-fixtures.mjs       # sau khi thêm log vào tests/fixtures/<loại>/
```
