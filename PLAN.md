# PLAN — limit-line v2, `/usage-plus` và distiller

> Tài liệu bàn giao cho Claude Code (chạy trong WSL2).
> Đọc hết trước khi code. Làm **theo đúng thứ tự giai đoạn**. Kết thúc mỗi giai đoạn thì dừng lại, báo kết quả cho người dùng và chờ xác nhận rồi mới sang giai đoạn sau.

---

## 0. Mục tiêu

Mở rộng mod **limit-line** hiện có (một plugin Claude Code kiểu *mod*) thành một bộ gồm ba phần:

1. **Band v2**: dòng hạn mức phía trên ô prompt. Giữ `5h | wk | ctx` như hiện tại, thêm `▲Δctx`, `cache %`, `dist`, và một dòng chi tiết bật/tắt bằng nút `[+]`/`[-]`.
2. **`/usage-plus`**: lệnh mở một pane dashboard với 3 tab Session / Week / Month. Pane hiển thị token theo loại, tỉ lệ cache hit, các lần cache bust kèm nguyên nhân, phân bổ theo model và project, lịch sử hạn mức, và thống kê distiller.
3. **Distiller**: hook `tool.call` trên Bash. Khi output quá dài, nó chưng cất output trước khi Claude đọc, đồng thời luôn lưu bản đầy đủ ra file. **Đợt này chỉ có bộ lọc pytest và generic**; cuda, docker, train/SFT để sau (xem mục "Để sau").

Ngoài phạm vi (không làm): model router, cache warmer, codemode.

---

## 1. Bối cảnh

- **Môi trường:** Claude Code chạy trong **WSL2**. Mods yêu cầu Claude Code **≥ 2.1.287**.
- **Mod limit-line hiện tại** đang chạy, hiển thị một dòng kiểu:
  `5h ▓▓░░ 13% 2h19m | wk ▓▓▓░ 34% T2 19:00 | ctx ▓░░ 7%   [-]`
  - Nguồn số liệu: sự kiện `session.measure`.
  - Đã có: lệnh `/limits`, toast ở mức 80% và 95%, dự báo cạn theo độ dốc, chế độ gộp một dòng khi màn hình hẹp.
  - Cấu trúc file: `hooks/register.tsx`, `hooks/limits.ts`, `types/index.d.ts`, `tests/limit-line.test.ts`.
- **Vị trí source:** `D:\my-mods-limit-line\my-mods\limit-line`, tức `/mnt/d/my-mods-limit-line/my-mods/limit-line` khi nhìn từ WSL. Marketplace tên `my-mods`.
- **Tài liệu tham khảo:**
  - <https://code.claude.com/docs/en/plugins/mods/overview>
  - <https://code.claude.com/docs/en/plugins/mods/api>
  - <https://code.claude.com/docs/en/plugins/mods/events>
  - <https://code.claude.com/docs/en/plugins/mods/reference>
  - Bài hướng dẫn Token Weather, Blast Radius, Replay Theater: <https://claude.dev/blog/getting-started-with-claude-code-mods/>
  - Skill có sẵn `plugin-authoring` (plugin built-in `cc-plugin-plugin-authoring`): dùng nó khi viết mod.

---

## 2. Nguyên tắc bắt buộc

1. **Types là nguồn sự thật.** Mọi chữ ký API trong tài liệu này (`$.tool...`, các field của `e`, cấu trúc `result`) đều là **giả định** cho tới khi đã đối chiếu với file `.claude-plugin/types/claude-code/index.d.ts` mà Claude Code sinh ra cho đúng bản đang chạy. Nếu khác, làm theo types và ghi lại vào `NOTES.md`.
2. **State nằm trong `$.state` hoặc file, không nằm trong biến module.** Mỗi lần hot reload, `register` và `session.start` chạy lại và biến module bị reset. Riêng biến module chỉ dùng cho cache tạm, chấp nhận mất khi reload.
3. **Mỗi hook có 10 giây cho phần chạy của riêng nó.** Thời gian chờ các lệnh gọi `$` không bị tính, trừ `$.clock.sleep`. Không xử lý nặng đồng bộ trong hook: tách sang `$.process.run` (script Node) hoặc chia nhỏ ra.
4. **Hành vi khi lỗi:**
   - UI (band, pane): khi lỗi thì trả về `next(e)` hoặc không vẽ gì. Không bao giờ được làm hỏng giao diện của Claude Code.
   - Distiller: khi lỗi thì **trả về kết quả gốc chưa qua xử lý**. Gắn `.catch` để trả kết quả gốc, tuyệt đối không để mất output.
5. **Không làm lộ bí mật.** Không ghi nội dung prompt hay output vào các file thống kê, chỉ ghi số liệu và metadata. File log đầy đủ của distiller nằm trong project của người dùng, ở `.claude/distill/`, và phải thêm thư mục này vào `.gitignore`.
6. **Chỉ tính luồng chính.** Bỏ qua các `turn.step`/`turn.complete` có `e.agentId`, trừ khi một mục nào đó ghi rõ là cần tính cả subagent.
7. **Giới hạn của mods API:** `$.fs.read`/`write` tối đa 4 MiB một file; `$.store` tối đa 4 MiB tổng; `$.process.run` timeout mặc định 30 giây, tối đa 10 phút; Text tối đa 10.000 ký tự một chuỗi; tên lệnh chỉ gồm `[A-Za-z0-9_-]`, tối đa 64 ký tự.
8. **Mỗi phần logic thuần (parse, lọc, tính toán, định dạng) nằm trong một module riêng, không phụ thuộc `$`, và có unit test.** `register.tsx` chỉ nối dây giữa các phần.
9. Dùng ký tự hiển thị một ô (`▓░▲▼●█▁▂▃▄▅▆▇`), **không dùng emoji**.

---

## 3. Kiến trúc và cấu trúc file

```
~/dev/my-mods/                      ← repo làm việc (git), KHÔNG làm trực tiếp trên /mnt/d
├── .claude-plugin/marketplace.json
└── limit-line/
    ├── .claude-plugin/plugin.json  ← có "types": "./types/index.d.ts"
    ├── hooks/
    │   ├── hooks.json              ← "modules": ["./register.tsx"]
    │   ├── register.tsx            ← nối dây: hooks, lệnh, render
    │   ├── limits.ts               ← (đã có) logic hạn mức
    │   ├── band.ts                 ← dựng các đoạn của band, bỏ bớt theo độ ưu tiên (thuần)
    │   ├── turnstats.ts            ← cộng dồn usage của từng turn từ turn.step (thuần)
    │   ├── ledger.ts               ← ghi bản ghi trực tiếp ra file ngày (nối với $)
    │   ├── dashboard.ts            ← dựng cây UI cho /usage-plus (thuần, nhận dữ liệu đã tính)
    │   ├── charts.ts               ← vẽ thanh, biểu đồ nhỏ, cột chồng bằng ký tự (thuần)
    │   ├── metrics.ts              ← công thức cache hit, phát hiện bust, gán nguyên nhân, tiền tiết kiệm (thuần)
    │   ├── pricing.ts              ← bảng giá theo model (cấu hình được)
    │   └── distill/
    │       ├── index.ts            ← pipeline: kiểm tra ngưỡng → làm sạch → nhận diện → lọc → chú thích
    │       ├── common.ts           ← bỏ ANSI, gộp \r, gộp dòng lặp, đầu/cuối, dòng lỗi + ngữ cảnh
    │       ├── detect.ts           ← nhận diện loại log theo NỘI DUNG
    │       ├── pytest.ts
    │       ├── cuda.ts
    │       ├── docker.ts
    │       └── train.ts
    ├── scripts/
    │   └── indexer.mjs             ← Node, đọc JSONL ~/.claude/projects → các file tổng hợp ngày
    ├── types/index.d.ts            ← khai báo PluginState
    └── tests/
        ├── fixtures/{pytest,cuda,docker,train}/*.log   ← log thật, đã xóa bí mật
        ├── fixtures/jsonl/*.jsonl                      ← mẫu JSONL để test indexer
        ├── band.test.ts  metrics.test.ts  distill.test.ts  dashboard.test.ts  ...
        └── limit-line.test.ts      ← (đã có)
```

**Thư mục dữ liệu bền của mod** (gọi tắt là `DATA_DIR`): đặt ngoài thư mục cài plugin, vì thư mục cài bị thay thế mỗi khi cập nhật. Thứ tự ưu tiên:
1. Thư mục dữ liệu riêng của plugin nếu types có cung cấp (tìm `data`, `CLAUDE_PLUGIN_DATA` trong types).
2. Nếu không có: `~/.local/share/limit-line/`.

Ghi lựa chọn cuối cùng vào `NOTES.md`.

```
DATA_DIR/
├── ledger/2026-10-02.json     ← bản ghi trực tiếp theo ngày (mảng RequestRecord), mỗi file < 4 MiB
├── measure/2026-10.json       ← các lần đọc session.measure (đã lấy mẫu thưa)
├── distill/2026-10.json       ← các DistillEvent
├── index/state.json           ← offset/mtime của từng file JSONL đã đọc
└── index/days/2026-10-02.json ← DayAgg do indexer sinh ra
```

---

## 4. Mô hình dữ liệu

```ts
type RequestRecord = {           // một request tới model (một turn.step)
  ts: number;                    // ms epoch
  sessionId: string;
  project: string;               // basename của cwd
  model: string;
  input: number; output: number;
  cacheRead: number; cacheWrite: number;      // cacheWrite = tổng; tách 5m/1h nếu có
  cacheWrite1h?: number;
  turnId?: string;
  isSubagent: boolean;
  source: 'live' | 'jsonl';
};

type DayAgg = {                  // tổng hợp theo ngày (giờ địa phương Asia/Bangkok)
  date: string;                  // YYYY-MM-DD
  byModel: Record<string, Tokens>;
  byProject: Record<string, Tokens>;
  total: Tokens;
  requests: number;
  busts: BustEvent[];            // tối đa 50 sự kiện mỗi ngày
};
type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };

type BustEvent = { ts: number; sessionId: string; project: string; model: string;
  ctx: number; cacheRead: number; cause: 'compact' | 'ttl' | 'model_switch' | 'session_start' | 'unknown' };

type MeasureSnapshot = { ts: number; fiveHourPct: number; weekPct: number; resetsAt5h?: number; resetsAtWeek?: number };

type DistillEvent = { ts: number; sessionId: string; kind: 'pytest'|'cuda'|'docker'|'train'|'generic';
  rawChars: number; outChars: number; logPath: string; reread: boolean };
```

---

## 5. Định nghĩa các chỉ số

Cài trong `metrics.ts`, mỗi công thức có unit test.

- **Context của một request:** `ctx = input + cacheRead + cacheWrite`.
- **Cache hit:** `cacheRead / (input + cacheRead + cacheWrite)`. Chỉ tính trên các request có `ctx > 0`. Tính gộp theo token, **không** lấy trung bình của các tỉ lệ.
- **Cache bust:** một request thỏa đồng thời:
  - `ctx ≥ 20_000`,
  - `cacheRead < 0.1 × ctx`,
  - và **không phải** request đầu tiên của session.
- **Gán nguyên nhân bust** (xét theo thứ tự, lấy điều kiện đầu tiên khớp):
  1. `compact`: có sự kiện compact trong cùng session, nằm giữa request này và request trước đó. Với dữ liệu trực tiếp thì quan sát qua `session.compact`; với JSONL thì tìm entry đánh dấu compact (tên field cần xác minh ở P0).
  2. `model_switch`: model khác model của request trước trong cùng session.
  3. `ttl`: khoảng cách tới request trước lớn hơn TTL của request trước. TTL tính theo từng request: `cacheWrite1h > 0` → 60 phút, ngược lại 5 phút. Dữ liệu live không tách 5m/1h (xem NOTES.md) nên mặc định 60 phút. Cả ba giá trị (5, 60, mặc định live) là tham số trong `metrics.ts`.
  4. `unknown`: không khớp điều kiện nào ở trên (có thể do system prompt hay tool thay đổi).
- **Chi phí:** tính theo `pricing.ts`, đơn vị USD trên 1 triệu token, gồm 4 mức giá: input, output, cache write (5 phút và 1 giờ), cache read.
  - Giá **phải được người dùng xác nhận**; để trong một object cấu hình, kèm ngày cập nhật.
  - Với gói subscription, hiển thị nhãn "API-equiv" để người dùng không nhầm với số tiền thật phải trả.
- **Tiền tiết kiệm nhờ cache** = (chi phí nếu mọi token cache read và cache write đều tính giá input thường) − (chi phí thực tế). Lưu ý: giá trị này **có thể âm** trong ngày có nhiều cache write.
- **Δctx của turn** = `ctx` của request cuối turn này − `ctx` của request cuối turn trước. Lấy từ `$.session.usage().context.tokens` sau `turn.complete`.
- **Ước tính usage ngoài máy này** (để ở mức tùy chọn, làm sau cùng trong P3): so % tăng của cửa sổ 5h (từ `session.measure`) với lượng token ghi nhận ở local trong cùng khoảng thời gian. Nếu % tăng lớn hơn nhiều so với lượng token local thì đánh dấu là "có dùng ở nơi khác".
  - Chỉ hiển thị khi có ít nhất 2 cửa sổ 5h đầy đủ để hiệu chỉnh tỉ lệ token/%.
  - Luôn kèm dấu `≈`.

---

## 6. Các giai đoạn

### P0 — Chuẩn bị (không viết tính năng)

**Việc cần làm:**
1. Chạy `claude --version` (yêu cầu ≥ 2.1.287), `node --version` (yêu cầu ≥ 18; nếu chưa có thì báo người dùng, **không tự cài**).
2. Chép source sang WSL: `cp -r /mnt/d/my-mods-limit-line/my-mods ~/dev/my-mods`, rồi `git init` và commit trạng thái ban đầu.
3. Chạy `claude --plugin-dir ~/dev/my-mods/limit-line` để Claude Code sinh file types; xác nhận band hiện tại vẫn chạy.
4. Đọc `.claude-plugin/types/claude-code/index.d.ts` và ghi vào `NOTES.md` (trích nguyên văn các khai báo liên quan):
   - Bash `tool.call`: các field của `e`, và **cấu trúc `result`**: output nằm ở field nào, có `isError` không, exit code nằm đâu. Cách tạo bản sao của `result` với output đã thay.
   - `turn.step`: các field của `result.usage` (có tách 5m/1h không, có `model` không), `e.agentId`, `e.turnId`.
   - `turn.complete`, `session.compact`, `session.measure`: các field.
   - `$.session.usage()`, `$.session.id()`, `$.session.cwd()`: cấu trúc trả về.
   - `$.fs` có nhận đường dẫn tuyệt đối không, có đọc được `~` không; `$.process.run`: cwd, env, timeout.
   - Phần tử UI: `Pane`, `AbovePrompt`, `Button` (hotkey), `Text`, `Box`; `$.ui.open`, `$.ui.close`; props `bodyColumns`, `placement`.
   - Có thư mục dữ liệu riêng của plugin không (xem mục `DATA_DIR` ở trên).
   - Tên lệnh `usage-plus` và `distill` có bị trùng không.
5. Lấy 3 file JSONL thật trong `~/.claude/projects/` (một session ngắn, một có compact, một có subagent). Xác minh:
   - Các field usage, `model`, `timestamp`, `sessionId`, `cwd`, `requestId`.
   - Cách đánh dấu compact. *(Dời sang P3: chưa có phiên nào compact.)*
   - **Entry trùng lặp**: nhiều dòng có cùng `message.id` và `requestId`; khóa để loại trùng là `message.id + requestId`.
   - **Xóa nội dung** trước khi đưa vào `tests/fixtures/jsonl/`: chỉ giữ cấu trúc và số liệu.
6. Hỏi người dùng các mẫu log thật cho 4 loại cần lọc (pytest lỗi, build CUDA lỗi, `docker logs` của API, log train/SFT), mỗi loại 1–2 file, đã xóa key và token.

**Hoàn thành khi:** có `NOTES.md` chứa đủ các khai báo trên và không còn câu hỏi "chưa rõ field"; fixture JSONL đã nằm trong repo.
**Dừng lại, báo người dùng.**

### P1 — Band v2

**Đặc tả hiển thị:**

```
5h ▓▓░░░░░░ 13% 2h19m | wk ▓▓▓░░░░░ 34% T2 19:00 | ctx ▓░░░░░░░ 7% ▲+18k | cache 91% | dist −142k   [+]
```

Khi bấm `[+]` (đổi thành `[-]`), thêm một dòng:

```
turn 4 req · in 61k (cache 55k · write 4k · new 2k) · out 2.3k · $0.42 · opus · ctx ▂▃▃▄▆▆█
```

**Các đoạn và ưu tiên** (số nhỏ = quan trọng hơn, bị bỏ sau cùng):

| Đoạn | Ưu tiên | Nội dung và màu |
|---|---|---|
| `5h …` | 1 | Như hiện tại |
| `wk …` | 1 | Như hiện tại |
| `ctx …` | 1 | Như hiện tại |
| `cache N%` | 2 | Tỉ lệ cache hit của **turn vừa xong**. Xanh ≥ 80, vàng 50–79, đỏ < 50 |
| `▲+Δ` / `▼−Δ` | 3 | Δctx của turn. Đỏ nếu Δ > 10% cửa sổ context, ngược lại vàng |
| `dist −N` | 4 | Tổng số ký tự distiller đã cắt trong phiên. Ẩn nếu bằng 0 |

**Quy tắc:**
- Dựng các đoạn theo thứ tự trên, đo độ rộng, rồi bỏ dần từ ưu tiên thấp nhất cho tới khi vừa `e.props.bodyColumns`. Chế độ gộp một dòng khi màn hình hẹp vẫn giữ như cũ.
- **Dòng turn:**
  - Số liệu cộng dồn từ mọi `turn.step` của luồng chính trong turn: số request, input, cacheRead, cacheWrite, output, model của request cuối.
  - Chi phí theo `pricing.ts`.
  - Biểu đồ ctx: 12 lần đọc gần nhất, lưu trong `$.state`.
- **`[+]`/`[-]`** dùng phần tử `Button` (hotkey nếu types cho phép). Trạng thái lưu trong `$.state`. Ghi nhớ giữa các phiên bằng `$.store` với key `band.expanded`.
- Khi `e.props.hasSurvey` thì trả `next(e)` (nhường chỗ cho survey).
- Thêm lệnh `/limits detail` để bật/tắt dòng chi tiết, ngoài nút bấm.

**State** (khai báo trong `types/index.d.ts`): `turn` (số liệu đang cộng dồn), `lastTurn`, `ctxHistory`, `distSession`, `expanded`.

**Test:**
- `band.test.ts`: bỏ đoạn đúng thứ tự ở các độ rộng 60/90/120/160; ngưỡng màu.
- `turnstats.test.ts`: cộng dồn đúng; bỏ qua request có `agentId`.
- Test tích hợp với `$.ui.mount` như bài Token Weather: gọi `turn.complete` thì band đổi `cache` và `▲`.

**Hoàn thành khi:** `claude plugin validate --strict` không còn cảnh báo, test qua, và người dùng xác nhận band trên terminal WSL nhìn ổn.
**Dừng lại.**

### P2 — Distiller (làm trước tầng dữ liệu)

**Phạm vi đợt này:** bộ lọc `pytest` và `generic`. Giữ kiến trúc `detect.ts` cộng mỗi bộ lọc một file, để thêm `cuda`/`docker`/`train` sau mà không phải sửa pipeline. Không cài torch, không cần docker.

**Hai đường, theo probe ở P0 (NOTES.md):**
- **Lệnh thành công:** chạy bình thường, rồi thay `result.stdout` bằng bản đã lọc (`result.stderr: ''`), giữ các field khác. Trên 30.000 ký tự thì đọc bản đầy đủ từ `persistedOutputPath`.
- **Lệnh lỗi:** core không nhận bản rút gọn của một kết quả `isError`. Vì vậy, với lệnh khớp allowlist (pytest, `python *train*`, `docker logs`, `pip install`, build), viết lại lệnh **trước khi chạy** thành wrapper: ghi output đầy đủ ra `.claude/distill/…log`, chạy `node <root>/hooks/distill/cli.ts` để in bản đã lọc, rồi `exit` đúng mã gốc. Lệnh không khớp allowlist mà lỗi thì đi thẳng, không lọc.

**Luồng xử lý:**

```js
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  const result = await next(e);           // permission + chạy lệnh như bình thường
  return distill($, e, result);           // mọi lỗi bên trong → trả về result gốc
}).catch(/* trả về kết quả gốc nếu đã có; nếu chưa có (lỗi trước next) thì để Claude Code bỏ qua hook */);
```

`distill()`:
1. **Đi thẳng, không xử lý**, nếu rơi vào một trong các trường hợp:
   - `result.deny`;
   - đã tắt bằng `/distill off`;
   - lệnh chứa `NO_DISTILL=1`;
   - lệnh đọc file trong `.claude/distill/` (để Claude xem được log đầy đủ);
   - output < `DISTILL_MIN_CHARS` (mặc định 8000).
2. **Lấy output đầy đủ:** `result.stdout` bị core cắt ở 30.000 ký tự. Khi có `result.persistedOutputPath` thì đọc file đó; model lúc này chỉ thấy 2 KB preview (NOTES.md).
   **Ghi output gốc** ra `<cwd>/.claude/distill/<yyyymmdd-HHMMSS>-<kind>.log`.
   - Nếu > 4 MiB thì chia thành nhiều phần.
   - Lần đầu ghi, thêm `.claude/distill/` vào `.gitignore` nếu chưa có.
3. **Làm sạch (`common.ts`):**
   - Bỏ mã ANSI.
   - Gộp `\r`: chỉ giữ trạng thái cuối của mỗi dòng tiến độ.
   - Gộp các dòng liên tiếp giống nhau, sau khi chuẩn hóa số và timestamp, thành `… (×N)`.
4. **Nhận diện loại log theo nội dung (`detect.ts`)**, theo thứ tự: pytest → cuda → train → docker → generic.
5. **Lọc theo loại**, xem bảng bên dưới.
6. **Gắn chú thích cuối:**
   `[distilled <kind> <raw>→<out> · full log: <path> · raw: rerun with NO_DISTILL=1]`
7. **Trả về bản sao của `result`** với output đã thay. **Giữ nguyên `isError`.** (Kết quả Bash không có trường exit code; lệnh lỗi có dạng `isError` và `text` bắt đầu bằng `Exit code N`. Xem NOTES.md.)
8. **Ghi `DistillEvent`** và cộng vào `distSession` trong state.

**Phát hiện "đọc lại":** nếu trong cùng session có một lệnh Bash, hoặc một lần gọi tool `Read`, chạm tới đường dẫn log của một sự kiện trước đó, thì đặt `reread=true` cho sự kiện đó. Hook `Read` chỉ để **quan sát**, không sửa gì.

**Bộ lọc** (mục tiêu: mỗi output đã lọc ≤ 4000 ký tự, cấu hình được):

| Loại | Nhận diện | Giữ lại | Bất biến bắt buộc |
|---|---|---|---|
| `pytest` | Dòng `=+ .* (passed\|failed\|error)` ở cuối, hoặc `short test summary info` | Dòng tổng kết; lỗi gom theo "chữ ký" (bỏ số và chuỗi trong nháy) kèm số lượng; traceback **đầu tiên** của mỗi nhóm (tối đa 25 dòng); tối đa 5 test ví dụ mỗi nhóm | Mọi `nodeid` bị FAILED/ERROR đều xuất hiện, hoặc được đếm trong nhóm của nó |
| `cuda` | `nvcc`, `ninja: build stopped`, `FAILED: `, `error:`, `torch.utils.cpp_extension` | Mọi dòng `error` kèm 3 dòng ngữ cảnh mỗi phía; dòng `FAILED:` của ninja; cảnh báo **gom theo mã** (ví dụ `#20012-D`) kèm số lượng và 1 ví dụ; lệnh cuối bị lỗi (cắt còn 300 ký tự) | Không mất dòng `error` nào |
| `train` | tqdm (`it/s`, `\|█`), dict `{'loss':`, `***** Running training`, `Epoch \d+` | Gộp thanh tiến độ; metric: dòng đầu, dòng cuối, min/max của loss, và lấy mẫu đều tối đa 15 dòng; warning gom theo nội dung; **giữ nguyên** traceback (OOM, NCCL, `RuntimeError`) | Traceback cuối cùng được giữ nguyên vẹn |
| `docker` | Phần lớn dòng bắt đầu bằng timestamp ISO; có HTTP status hoặc method | Bảng đếm theo `status × method path` (top 10); dòng 4xx/5xx gom theo chữ ký (top 10, mỗi nhóm 1 ví dụ); stack trace giữ nguyên; khoảng thời gian từ dòng đầu tới dòng cuối | Mọi stack trace được giữ |
| `generic` | Không khớp loại nào | 40 dòng đầu, 80 dòng cuối, cộng mọi dòng chứa `error\|fail\|traceback\|exception\|fatal` (không phân biệt hoa thường) kèm 2 dòng ngữ cảnh | — |

**Lệnh** (đăng ký trong try/catch; trùng tên thì dùng `distill-x` và ghi NOTES.md):
- `/distill on|off`: bật/tắt, lưu vào `$.store`.
- `/distill stats`: in ra số lần, tổng số ký tự đã cắt theo loại, tỉ lệ đọc lại.
- `/distill last`: in đường dẫn log của lần gần nhất.

**Test (`distill.test.ts`):**
- Với mỗi fixture: (a) giảm ≥ 80% kích thước, (b) giữ đúng các bất biến trong bảng, (c) output đã lọc ≤ giới hạn, (d) có chú thích cuối.
- Bộ lọc `generic`: **không mất dòng error/traceback nào trên mọi fixture hiện có** (chạy generic trên cả fixture pytest).
- Wrapper: giữ đúng mã thoát gốc; output đầy đủ có trong file log.
- Không đổi `isError`; lệnh có `NO_DISTILL=1` đi thẳng; output ngắn đi thẳng.
- Hàm lọc ném lỗi thì trả về kết quả gốc.
- Hiệu năng: fixture 4 MiB xử lý trong < 2 giây, đo bằng `performance.now`.

**Hoàn thành khi:** test qua trên fixture thật của người dùng, và chạy thử pytest thật trong một phiên thì thấy kết quả đã chưng cất cùng `dist −N` trên band.
**Dừng lại.**

### P3 — Tầng dữ liệu

**3a. Ledger (dữ liệu trực tiếp):**
- `turn.step`: sau khi `yield* next(e)` xong, lấy `result.usage` và ghi một `RequestRecord` vào bộ đệm trong state.
- Khi `turn.complete`, ghi bộ đệm vào `DATA_DIR/ledger/<ngày>.json` (đọc, nối thêm, ghi lại; file theo ngày nên luôn nhỏ).
- Ghi lại cả request của subagent, nhưng đặt `isSubagent=true`.
- `session.measure`: lưu `MeasureSnapshot` vào `DATA_DIR/measure/<tháng>.json`, chỉ ghi khi % thay đổi hoặc đã quá 10 phút kể từ lần ghi trước.
- `session.compact`: ghi một dấu mốc (ts, sessionId) để phục vụ gán nguyên nhân bust.

**3b. Indexer (`scripts/indexer.mjs`, chạy bằng Node):**
- Gọi bằng `$.process.run(['node', <root>/scripts/indexer.mjs, '--data', DATA_DIR, '--since', <ngày>], { timeout: 120000 })`.
- Đọc `~/.claude/projects/**/*.jsonl` theo dòng, **tăng dần**: lưu `{path: {size, mtime, offset}}` trong `index/state.json` và chỉ đọc phần mới.
- Lấy các entry assistant có usage; **loại trùng** theo `message.id + requestId`; giờ địa phương Asia/Bangkok.
- Ghi ra `index/days/<ngày>.json` (`DayAgg`), có tính sẵn `busts` theo mục 5.
- In một dòng JSON tóm tắt ra stdout để mod đọc.
- Không ghi nội dung tin nhắn vào bất kỳ file nào.
- Có cờ `--rebuild` để xóa state và đọc lại từ đầu.

**3c. Hợp nhất:** dashboard dùng `DayAgg` từ indexer làm **nguồn chính** cho lịch sử. Ledger chỉ dùng cho tab Session và cho khoảng thời gian indexer chưa chạy tới.

**Test:**
- Indexer trên fixture JSONL: loại trùng đúng, tách đúng theo ngày, phát hiện bust đúng và gán đúng nguyên nhân (một ca cho mỗi loại nguyên nhân).
- `metrics.test.ts` cho mọi công thức ở mục 5.

**Kiểm chứng:** trên **mọi ngày dữ liệu thật hiện có (ít nhất 2)**, tổng token mỗi ngày khớp `npx ccusage@latest daily --json` trong khoảng **±1%**; kiểm lại khi đủ 7 ngày. Nếu lệch thì ghi lý do vào `NOTES.md`. Đây chỉ là bước đối chiếu, không phải phụ thuộc lúc chạy.

**Compact và subagent (dời từ P0):** tạo một phiên có `/compact` và một phiên dùng Agent tool, xác minh dấu compact và cách ghi subagent trong JSONL, thêm fixture đã làm sạch, rồi mới viết test gán nguyên nhân `compact`.

**Hoàn thành khi:** khớp ±1% và chạy indexer tăng dần lần thứ hai mất < 2 giây.
**Dừng lại.**

### P4 — `/usage-plus`

- **Lệnh:** đăng ký `usage-plus` trong `session.start`, kèm `immediate: true`, bọc trong try/catch. Nếu trùng tên thì đăng ký `usage-x` và ghi vào NOTES.md.
  - `command.run`: chạy indexer (tăng dần), mở pane bằng `$.ui.open({ id: 'usage-plus', title: 'usage-plus', focus: true })`, rồi trả `{}`.
  - Mở từ lệnh của người dùng thì pane luôn được đặt (NOTES.md). Chỉ giữ guard tối thiểu: nếu `isPlaced: false` thì trả `{ text: <reason> }`, không vẽ gì ở band.
- **Tab:** dùng `Button` với hotkey `1`/`2`/`3`; nút đóng `x`; tab đang chọn lưu trong `$.state`.
  - **Session:** từng turn của phiên hiện tại (từ ledger): bảng 10 turn gần nhất (thời điểm, số request, cache %, Δctx, chi phí), top 3 turn tốn nhất, các lần bust trong phiên.
  - **Week:** 7 ngày gần nhất, bố cục như dưới.
  - **Month:** gộp theo tuần (4–5 cột) cộng biểu đồ nhỏ theo ngày của cả tháng.
- **Bố cục tab Week** (tham chiếu từ mockup đã thống nhất):

```
╭─ usage-plus ──────────────────────────────────────────────── [x] ─╮
  [1 Session]  2 Week   3 Month                   7 ngày qua · tz +07

 tokens/ngày   █ cache read  █ cache write  █ input  █ output
 T6 26 ██████████████████████████       18.4M
 T7 27 ██████████                        8.1M
 ...
 cache hit  ▇▇_██▅▇▇   tuần 89%   tiết kiệm ≈ $184 so với không cache

 cache bust gần đây                     ctx     đọc cache
 ● T3 14:02  sau /compact               142k    0k
 ● T3 16:40  nghỉ 9 phút (TTL hết)       98k    2k
 ● T4 10:15  đổi model sonnet → opus     61k   12k

 theo model        theo project            hạn mức (lịch sử)
 opus   ██████ 64% gs-slam   █████ 51%    5h ▂▃▆█▃▂▁ đỉnh 97% T2
 sonnet ███    31% sft-run   ███   28%    wk ▁▂▃▄▅   34% → dự báo 71%
                                          ngoài máy này ≈ 12%

 distiller  23 lần · −1.9M ký tự · đọc lại 2/23 (9%)
 pytest −610k  cuda −880k  docker −240k  train −170k
╰───────────────────────────────────────────────────────────────────╯
```

- **Màu:**
  - Cột chồng: cache read xanh lá, cache write vàng, input xanh dương, output tím.
  - Chấm bust: đỏ cho `compact`/`ttl`, vàng cho `model_switch`, xám cho `unknown`.
  - Tỉ lệ cache: dùng cùng ngưỡng với band.
- **Độ rộng:** co giãn theo `bodyColumns`.
  - Dưới 80 cột: các cột "theo model / project / hạn mức" xếp chồng theo chiều dọc.
  - Dưới 60 cột: chỉ hiện tổng và cache hit.
- **Desktop:** cùng một cây phần tử; chưa dùng `Svg` ở phiên bản này.
- **Tiêu đề và nhãn** viết tiếng Việt như mockup; số dùng định dạng `k`/`M`.
- **Test:** `dashboard.test.ts` mount pane với dữ liệu giả cho cả 3 tab và các độ rộng 60/90/120; hotkey đổi tab đúng; không có dòng nào vượt độ rộng.

**Hoàn thành khi:** người dùng mở `/usage-plus` trên dữ liệu thật và xác nhận.
**Dừng lại.**

### P5 — Đóng gói và cài đặt

1. Cập nhật `version` trong `plugin.json` (minor bump), `description`, và `marketplace.json`.
2. Chạy `claude plugin validate --strict ~/dev/my-mods/limit-line` và `claude plugin test ~/dev/my-mods/limit-line`.
3. Cài trong WSL:
   ```
   /plugin marketplace add ~/dev/my-mods
   /plugin install limit-line@my-mods
   /reload-plugins
   ```
   Nếu marketplace cũ trỏ tới `/mnt/d/...` đang tồn tại thì gỡ trước, sau khi người dùng đồng ý.
4. Viết `README.md` của plugin: tính năng, các lệnh (`/limits`, `/limits detail`, `/usage-plus`, `/distill …`), `NO_DISTILL=1`, vị trí dữ liệu, cách xóa dữ liệu, giới hạn đã biết.
5. Hỏi người dùng có muốn chép bản cuối về `D:\my-mods-limit-line` để Desktop (Windows) dùng chung không.

---

## 6b. Để sau

- Bộ lọc `cuda` (build CUDA / `cpp_extension`): cần fixture thật, cần torch + nvcc.
- Bộ lọc `docker` (log API trong container): cần bật Docker Desktop WSL integration.
- Bộ lọc `train` (train/SFT): chưa có log mẫu.

Khi làm: thêm một file trong `hooks/distill/`, một nhánh trong `detect.ts`, fixture thật trong `tests/fixtures/<kind>/`, và các bất biến ở bảng bộ lọc phía trên.

## 7. Rủi ro và cách xử lý

| Rủi ro | Cách xử lý |
|---|---|
| Cấu trúc `result` của Bash khác giả định | P0 bắt buộc xác minh; distiller có `.catch` trả về kết quả gốc |
| Distiller cắt mất thông tin Claude cần | Luôn có log đầy đủ, `NO_DISTILL=1`, theo dõi tỉ lệ đọc lại. Nếu tỉ lệ đọc lại của một loại > 20% thì nới bộ lọc đó |
| Format JSONL thay đổi giữa các phiên bản Claude Code | Indexer bỏ qua dòng không parse được và đếm số dòng lỗi; hiển thị cảnh báo nhỏ trong pane nếu > 1% |
| Đọc `/mnt/d` từ WSL chậm | Làm việc trong `~/dev`; indexer đọc `~/.claude` của WSL |
| Hook vượt 10 giây | Phần nặng chạy qua `$.process.run`; lọc bằng regex tuyến tính, không backtracking nặng |
| Giá thay đổi | Bảng giá cấu hình được, kèm ngày cập nhật, nhãn "API-equiv" |
| Hai mod cùng vẽ `AbovePrompt` | Khi có survey thì trả `next(e)`; giữ cố định 1–2 dòng |

---

## 8. Quyết định mặc định (hỏi người dùng nếu muốn đổi)

- **Tên lệnh:** `/usage-plus`, `/distill`, `/limits detail`.
- **Nguồn lịch sử:** tự viết indexer; `ccusage` chỉ dùng để đối chiếu ở P3.
- **Ngưỡng distiller:** 8000 ký tự; output sau lọc ≤ 4000 ký tự.
- **Ngưỡng màu cache:** ≥ 80 xanh, 50–79 vàng, < 50 đỏ.
- **Múi giờ:** Asia/Bangkok.

## 9. Hoàn thành toàn bộ khi

- [ ] P0–P5 đều đạt tiêu chí và người dùng đã xác nhận ở mỗi bước dừng.
- [ ] `claude plugin validate --strict` và `claude plugin test` đều sạch.
- [ ] Sau một tuần dùng thật: tỉ lệ đọc lại của distiller < 10%; số token trên dashboard khớp ccusage ±1%.
