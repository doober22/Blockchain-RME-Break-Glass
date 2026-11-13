# Setup dan hasil validasi

Panduan milestone parsial. [README](../README.md) membedakan skeleton dari fitur Planned. Jalankan perintah dari root kecuali disebut lain; hentikan tahap yang blocked, jangan menganggapnya berhasil.

## Prasyarat dan versi

| Komponen | Acuan repository |
| --- | --- |
| Node.js | 24.x; `smart-contract/package.json` mensyaratkan `>=24.0.0 <25`. |
| npm | Mendukung lockfile versi 3; belum ada pin versi npm. Gunakan `npm ci`. |
| Hardhat | 3.21.1 di lockfile; deklarasi package `^3.0.0`. |
| Solidity/OpenZeppelin | Compiler 0.8.28, OpenZeppelin 5.6.1. |
| EVM | Target `paris`, optimizer aktif 200 runs; Role 1/2 perlu menyamakan genesis fork schedule. |
| Docker + Compose | Untuk rencana Besu; image Besu dan minimum versi Compose belum ditentukan. |
| Browser + MetaMask | Untuk integrasi mendatang, belum diuji dengan frontend. |
| TypeScript/viem | Stack integrasi yang direncanakan; belum ada package frontend/oracle atau pin versi. |

## Urutan clean-clone

1. Clone repository dari remote tim, masuk root, lalu aktifkan Node 24 dan periksa `node --version` serta `npm --version`.
2. **Environment preparation: parsial.** Root `.env.example` belum ada. Role 1 harus menyediakan template dan cara pemuatannya. Hardhat saat ini membaca `process.env`, bukan otomatis membaca `.env`.

   | Key bersama | Nilai/kegunaan | Status saat ini |
   | --- | --- | --- |
   | `BESU_CHAIN_ID` | `1337` | Config memvalidasi positive safe integer bila disetel; tidak otomatis memaksa 1337. |
   | `BESU_RPC_URL` | Host `http://127.0.0.1:8545` | Default di config; endpoint container menunggu nama service Role 1. |
   | `DEPLOYER_PRIVATE_KEY` | Secret akun deployment throwaway | Belum dikonsumsi config; `accounts: []`. Jangan isi di frontend. |

   Contoh environment non-secret pada PowerShell, hanya untuk shell tersebut:

   ```powershell
   $env:BESU_CHAIN_ID = '1337'
   $env:BESU_RPC_URL = 'http://127.0.0.1:8545'
   ```

3. **Chain initialization/start: blocked.** Tidak ada Compose/genesis/script. Role 1 harus memberikan perintah aktual, pin Besu, empat validator QBFT, permissioning, dan onboarding/funding. Jangan mengganti langkah ini dengan perintah Compose tebakan.
4. **Health check: blocked untuk jaringan proyek.** Role 1 harus memberikan command yang memverifikasi RPC, `eth_chainId = 0x539`, kemajuan blok, dan quorum empat validator. Port terbuka saja belum membuktikan kesehatan QBFT.
5. **Dependency installation dan compile: tersedia tanpa chain.** Dari root:

   ```sh
   cd smart-contract
   npm ci
   npm run compile
   ```

   Compile dapat memerlukan akses jaringan untuk compiler. Jangan mengubah lockfile untuk melewati kegagalan dependency.
6. **Tests: blocked.** Script `test` belum ada dan `test/` hanya placeholder. Role 2 harus menyediakan test perilaku; jangan melaporkan nol test sebagai keberhasilan otorisasi.
7. **Deployment: blocked.** Script `deploy:besu`, signer, dan output deployment belum ada. Constructor `ParticipantRegistry` me-revert; metode bisnis kedua kontrak masih me-revert. Role 2 perlu memperbaiki ini sebelum deployment bermakna.
8. **Address/ABI verification: blocked sampai deployment.** Periksa manifest `smart-contract/deployments/1337.json`, chain ID numerik 1337, dua address nonzero, dan `deploymentTransactions`. Role 2 harus mengonfirmasi format field transaksi dan nama file ABI. Verifikasi receipt sukses, bytecode pada kedua address di RPC yang benar, serta kecocokan ABI dengan build deployment; address berformat valid saja tidak cukup. Lihat [integrasi](integration-contract.md).
9. **Frontend/oracle: Planned.** Tidak ada package atau start script. Handoff berikutnya: Role 2 menghasilkan manifest/ABI, Role 1 menyediakan chain, kemudian implementer memasang viem, wallet, dan worker berdasarkan scaffold.

Tahap compile dapat dikerjakan mandiri meskipun tahap chain masih blocked. Belum ada instalasi/use-case end-to-end atau demo/video yang tervalidasi; URL demo belum tersedia.

## MetaMask dan development accounts

Tambahkan custom network `RME Besu Local`, RPC host `http://127.0.0.1:8545`, chain ID `1337`, dan symbol lokal `DEV`. Network belum dapat digunakan sebelum Besu tersedia. Dari container gunakan endpoint internal yang akan ditetapkan Role 1, bukan host loopback.

Gunakan wallet development throwaway. Role 1 harus mengizinkan akun sesuai permissioning dan mendokumentasikan funding/genesis allocation; Role 2 harus mendokumentasikan registrasi role, fasilitas, dan kredensial. Jangan memakai seed wallet pribadi. Jangan menaruh private key di konfigurasi browser atau repository. Approval jaringan, saldo gas, dan hak baca merupakan pemeriksaan terpisah.

## Stop, restart, dan reset

| Operasi | Status dan tindak lanjut Role 1 |
| --- | --- |
| Stop | Blocked: belum ada command proyek. Harus menghentikan layanan tanpa menghapus ledger. |
| Restart | Blocked: belum ada command proyek. Harus mempertahankan chain data dan memeriksa health kembali. |
| Reset | Blocked: belum ada command proyek, sehingga belum ada command penghapus data yang dapat disebut secara akurat. Role 1 wajib menyebut command aktual dan path/volume yang dihapus. |

Tidak ada reset destruktif yang dijalankan pada validasi milestone ini. Setelah reset di masa depan, anggap address lama, checkpoint oracle/indexer, dan grant lama tidak valid: deploy ulang, regenerasi manifest/ABI, cocokkan bytecode, lalu muat ulang client. Chain ID yang sama tidak membuktikan deployment lama masih ada.

## Troubleshooting

| Gejala | Pemeriksaan/tindakan |
| --- | --- |
| Wrong network | Cocokkan chain ID wallet, RPC, dan manifest ke 1337; helper frontend menolak mismatch. |
| RPC unavailable | Pastikan infra sudah disediakan, service hidup, port dipublikasikan, dan endpoint host/container sesuai. Saat ini service proyek belum ada. |
| Unauthorized account | Periksa permissioning jaringan dan registrasi role/fasilitas/kredensial aktif; funding bukan izin akses. Implementasi kontrak saat ini masih stub. |
| Missing development balance | Minta funding development melalui prosedur Role 1; jangan memakai dana/aset nyata. |
| Incompatible dependencies | Aktifkan Node 24, jalankan `npm ci` sesuai lockfile. Node 22.12.0 gagal sebelum compile. |
| `NotImplemented()` | Ini batas skeleton, bukan kesalahan MetaMask. Tunggu implementasi Role 2. |
| Missing script `test`/`deploy:besu` | Script belum dikirim Role 2; jangan membuat klaim test/deployment sukses. |
| Stale addresses setelah reset | Regenerasi deployment dan validasi receipt/bytecode; jangan mengandalkan address atau chain ID saja. |

## Catatan validasi — 30 Oktober 2026

Lingkungan awal: Node 22.12.0, npm 11.5.1, Docker 29.8.1, Compose v5.5.1. Node 24.22.2 diperoleh sementara melalui npm exec; Node sistem tidak diganti. Validasi dilakukan di checkout ini, bukan clean clone terpisah.

| Pemeriksaan | Hasil aktual |
| --- | --- |
| `npm run compile` dengan Node sistem 22.12.0 | Gagal: Hardhat menolak versi Node. Gunakan Node 24 sesuai engines proyek. |
| `npm ci` | Berhasil pada Node sistem dengan warning engines (85 package), lalu diulang pada Node 24.22.2 tanpa warning engines (53 package). Hasil npm audit pada kedua instalasi melaporkan 3 high-severity vulnerabilities; tindak lanjut dependency milik Role 2, tanpa menjalankan audit fix. |
| Compile melalui CLI Hardhat pada Node 24.22.2 | Berhasil: `Compiled 2 Solidity files with solc 0.8.28 (evm target: paris)`. Ada warning unused parameters pada skeleton; tidak menguji perilaku kontrak. |
| `npm run compile` pada Node 24.22.2 setelah `npm ci` ulang | Lulus, exit 0: `No contracts to compile` karena artifact compile sebelumnya masih valid. |
| TypeScript 5.9.3, `--noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler` | Lulus untuk `frontend/integration.ts` dan `oracle/emergency-context.ts`; compiler sementara untuk verifikasi, bukan dependency proyek baru. |
| Guard frontend melalui Node 24 | Lulus: manifest valid, chain ID angka/hex valid, wallet/RPC mismatch, chain ID malformed, field hilang/null, serta address nol/pendek/nonhex/salah tipe pada kedua kontrak. |
| Relative links | Semua 12 link lokal pada enam dokumen Markdown valid. |
| Schema dan signature | Sebelas field oracle cocok dengan dokumen; signature `resolveEmergency` dan struktur `getRequest` diperiksa terhadap ABI hasil compile. Manifest deployment aktual belum ada. |
| Script/env/path ownership | Hanya `compile` tersedia. Key environment, default RPC, chain parsing, dan signer kosong sesuai config. File Role 1/2 tidak diubah. |
| `git diff --check` | Lulus; perubahan hanya pada delapan file Role 3. |
| Tests/deployment/chain/frontend/oracle runtime | Tidak dijalankan: komponen atau script belum tersedia. Tidak ada reset destruktif. |

Untuk mengulang pemeriksaan tipe secara opsional dari root, tanpa menambah dependency repository:

```sh
npm exec --yes --package=typescript@5.9.3 -- tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler frontend/integration.ts oracle/emergency-context.ts
```

Hasil compile dan helper lokal tidak membuktikan authorization, oracle validation, atau record delivery sudah berjalan. ABI pada `artifacts/` hasil compile juga bukan pengganti ekspor ABI publik dan manifest deployment yang harus disediakan Role 2.
