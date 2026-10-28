# OMB-Claw Project Status

## Branch: feature/fetch-lazy-fix (sandbox boundary)

### Commit: f638333be — feat: implement sandbox boundary (workspace-write/read-only/full/custom) for native shell tool

### Akurasi klaim vs kenyataan

| Item | Klaim | Aktual (terverifikasi) |
|------|-------|------------------------|
| `server/agent-runtime/sandbox.ts` | Baru, 3928 bytes | ✅ Ada, diverifikasi |
| `server/agent-runtime/sandbox.test.ts` | Baru, 21 tests | ✅ Ada, 17 tests (semua lolos) |
| `server/agent-runtime/native-shell-tool.test.ts` | 6 tests | ✅ Ada, 8 tests (semua lolos) |
| `pnpm typecheck` | Clean | ✅ 0 error |
| Total test terkait sandbox | — | 25 lolos (17 + 8) |

### File yang terlibat (integrasi utuh)

1. `server/agent-runtime/sandbox.ts` (baru) — `SandboxMode`, `parseSandboxMode()`, `checkCommandSafety()`, `escapesWorkspace()`
2. `server/agent-runtime/native-shell-tool.ts` — impor modul sandbox, `ShellToolContext.sandboxMode` + `allowedCommands`, panggil `checkCommandSafety()` sebelum `exec()`
3. `server/contracts.ts` — `sandboxMode?: unknown` pada `SendTurnInput` (baris 110-111)
4. `server/agent-runtime/turn-runtime.ts` — baca `turn.sandboxMode ?? process.env.OMB_SANDBOX_MODE ?? "workspace-write"`, baca `OMB_SANDBOX_ALLOWED_COMMANDS`

### Empat mode sandbox

| Mode | Perilaku |
|------|----------|
| `workspace-write` (default) | Izinkan tulis di dalam workspace; blokir escape lewat traversal / path sistem |
| `read-only` | Blokir semua operasi tulis; tetap blokir path escape |
| `full` | Tanpa batasan (host command, env terinherit) |
| `custom` | Hanya command yang ada di `allowedCommands`; blokir escape |

### Temuan keamanan (perlu diperbaiki sebelum produksi)

**G1 — Bypass deteksi path-escape lewat redirection tanpa spasi**
Regex `escapesWorkspace` butuh pemisah (`[\s;&|]`) sebelum path sistem. Perintah ini lolos deteksi:
```
cat</etc/passwd    <- '<' bukan di [\s;&|], tidak diblokir
cat>/etc/passwd    <- '>' juga tidak, tidak diblokir
```

**G2 — Interpreter-based write tidak terdeteksi (`isWriteCommand`)**
Regex hanya menangkap perintah bawaan (`rm`, `cp`, `tee`, `curl`, `wget`). Ini lolos di mode `read-only`:
```
python3 -c "open('/tmp/evil','w').write('x')"
node -e "require('fs').writeFileSync('/tmp/evil','x')"
```

**G3 — `/tmp` tidak dalam daftar direktori sistem yang diblokir**
`escapesWorkspace` blokir `/etc`, `/proc`, `/sys`, `/dev`, `/var/log`, `/root`, `/home` — tapi **tidak `/tmp`**. Di mode `workspace-write`, `mkdir /tmp/evil` tetap diizinkan meskipun di luar workspace.

**G4 — Custom mode hanya memeriksa token pertama (head command)**
`allowedCommands: ["ls"]` mengizinkan:
```
ls; rm -rf /
ls && rm -rf /
```
Hanya `ls` yang dicek; sisa rangkaian perintah setelah `;`, `&&`, `||`, `|` tidak divalidasi.

**G5 — `shell: true` tetap digunakan**
`execAsync(command, { ..., shell: true })` dieksekusi melalui `/bin/sh -c`. Jika `args.command` berasal dari input tidak tervalidasi, risiko command injection tetap ada.

### Langkah selanjutnya

- [ ] Perbaiki G1-G5 di `sandbox.ts`
- [ ] Tambah test case untuk setiap gap keamanan di atas
- [ ] Re-run `pnpm typecheck` dan seluruh test suite `server/`
- [ ] Merge ke `feature/native-agent-engine` setelah lolos

## Branch: feature/native-agent-engine (HEAD saat ini)

### Commit: 2cc962282 — feat: complete native agent engine test fixes

Perbaikan 10 test gagal (openai-chat + driver-opt-in):
- `noteKeyAccepted` dipanggil pada response sukses di `model-adapter.ts`
- `httpErrorLabel` diteruskan ke semua 10 driver (openai-compat, grok, meta, minimax, mistral, anthropic, gemini, cerebras, openai-responses)
- `httpErrorDetail` status-aware: body 4xx dimasukkan, 5xx ditahan (hindari kebocoran rahasia)
- `fetcher` di-resolve di dalam `generate()` sehingga `vi.stubGlobal("fetch", ...)` bekerja setelah `create()`
- Beberapa steer mid-turn digabung menjadi satu pesan user dengan pemisah `\n\n`
- `driver-opt-in.test.ts` pakai `agentEngine: "omb-native"` pada semua turn
- Typecheck: 0 error; semua test `server/` lolos; `pnpm build` sukses
- Telah di-push ke remote `feature/native-agent-engine`
