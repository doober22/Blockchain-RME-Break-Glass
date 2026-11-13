# Blockchain RME Break-Glass

Proyek IF4035 Blockchain — Kelompok 6. Prototipe ini mengembangkan access control RME dengan dua jalur: akses normal melalui patient consent dan akses darurat melalui break-glass yang diverifikasi oracle. Semua pasien, encounter, dan record menggunakan data sintetis; tidak ada koneksi ke SATUSEHAT produksi.

SATUSEHAT sudah menyediakan emergency consent. Kontribusi yang diusulkan adalah otorisasi terdesentralisasi dan audit trail bersama antaranggota konsorsium. Belum ada pengukuran yang membuktikan peningkatan security atau latency terhadap SATUSEHAT.

## Status milestone

Status didasarkan pada source dan hasil pemeriksaan di [panduan chain](docs/private-chain.md) serta [setup](docs/setup.md). Medical access control lengkap belum dapat didemokan end-to-end.

| Bagian | Status | Bukti dan batasan |
| --- | --- | --- |
| Struktur repository, MIT, dan scaffold integrasi | Implemented and verified | Direktori wajib, lisensi, helper frontend, tipe oracle, dan dokumen tersedia. |
| Tooling private chain | Implemented and verified | Compose lima node, init, permission files, lifecycle, onboarding, dan tes safeguard tersedia; hasil runtime dicatat di panduan chain. |
| Jaringan Besu QBFT lokal | Implemented and verified | Chain ID 1337, blok maju, empat validator, account permissioning, satu validator berhenti, dan persistence lulus pada 13 November 2026. |
| Konfigurasi MetaMask development | Implemented but unverified | Parameter jaringan/origin tersedia; interaksi browser dan UI belum diuji secara manual. |
| ParticipantRegistry | Implemented and verified | Role, fasilitas, kredensial, expiry, dan pemisahan role diimplementasikan; lihat tes di panduan kontrak. |
| Controller skeleton dan tooling deployment | Implemented and verified | Constructor/getter metadata, ABI arrays, 21 tes Solidity dan 8 tes deployment lulus; kedua kontrak berhasil di-deploy dan diverifikasi pada Besu. |
| Consent, break-glass, authorization, dan review fungsional | Planned | Operasi bisnis MedicalAccessController tetap me-revert NotImplemented(). |
| Frontend, worker oracle, mock API, gateway, encrypted storage/key service, indexer | Planned | Frontend/oracle hanya scaffold; belum ada command startup aplikasi. |
| Demo/video dan panduan use-case fungsional | Planned | Belum tersedia rekaman atau URL demo; panduan instalasi chain dan kontrak tersedia. |

## Masalah, kontribusi, dan alur target

Pertukaran RME membutuhkan kewenangan tenaga medis yang dapat diverifikasi, scope akses yang jelas, dan pertanggungjawaban ketika pasien tidak mampu memberi consent. Private consortium blockchain memungkinkan fasilitas yang dikenal berbagi verifikasi kebijakan serta ledger audit. Permissioning jaringan membatasi node dan pengirim transaksi; access control aplikasi tetap menjadi lapisan terpisah.

Alur berikut masih merupakan rancangan aplikasi:

1. **Normal:** pasien memberi consent kepada dokter untuk record dan expiry tertentu. Gateway membuktikan wallet dan memeriksa otorisasi final sebelum melayani baca; pasien dapat mencabut consent.
2. **Darurat:** dokter aktif meminta record terpilih untuk encounter tertentu. Request saja tidak membuka data. Oracle mengambil konteks dari API fasilitas sintetis yang dikelola independen dari form dokter, lalu mengirim keputusan yang terikat pada request. Kontrak kelak memberi akses read-only dengan expiry; gateway memeriksa ulang scope, kredensial, dan status setiap kali digunakan.
3. **Setelah akses:** pasien memperoleh riwayat/notifikasi dan auditor melakukan review. Penutupan atau expiry menghentikan akses berikutnya; data yang sudah diterima tidak dapat ditarik kembali.

Prinsip least privilege memisahkan pasien, dokter, admin, oracle, gateway, dan auditor. Metadata minimum dan audit trail berada dalam rancangan on-chain; ciphertext, kunci, pemetaan identitas, dan fakta klinis tetap off-chain. Hash mendukung integrity ciphertext, bukan kebenaran diagnosis.

Konstanta controller menetapkan target eksperimen: maksimal 15 menit akses darurat, 60 detik usia attestation, deadline request 120 detik, 20 record/request, dan review 24 jam. Penegakan operasi medis tersebut masih Planned, bukan standar klinis atau hasil evaluasi.

## Struktur dan ownership

```text
infrastructure/                # Role 1: Compose, init, lifecycle, permissioning, tes
frontend/                      # Role 3: scaffold konsumsi address/ABI dan guard jaringan
smart-contract/                # Role 2: kontrak, Hardhat, tests, deployment
  contracts/
  scripts/
  test/
  abi/                         # ABI arrays publik
  deployments/                 # Output publik 1337.json setelah deployment
oracle/                        # Role 3: kontrak data dan rancangan worker
docs/
  private-chain.md             # Role 1
  smart-contracts.md           # Role 2
  setup.md                    # Role 3: setup lintas komponen
  architecture.md             # Role 3: komponen dan trust boundaries
  integration-contract.md     # Role 3: kesepakatan integrasi
.env.example                  # Role 1: template tanpa secret
package.json, package-lock.json # Role 1: orchestration, tanpa workspace
LICENSE
README.md                     # Role 3
```

Role 1 memiliki infrastruktur, root scripts, environment template, dan .gitignore. Role 2 memiliki smart-contract/ dan panduan kontrak. Role 3 memiliki scaffold frontend/oracle serta dokumentasi aplikasi. Sinkronisasi dokumen pada tahap ini mencerminkan hasil Role 1/2 tanpa mengubah source atau package ownership kontrak.

## Setup

Prasyarat: **Node.js 24.x**, npm, Docker dengan Linux containers/Compose, serta browser dengan MetaMask untuk integrasi wallet mendatang. Besu **26.11.0**, probe Node **24.22.2-alpine**, viem **2.57.16**, Hardhat **3.21.1**, Solidity **0.8.28**, OpenZeppelin **5.6.1**, TypeScript **5.9.3**. Versi masing-masing package dikunci dalam lockfile root/subproyek.

Setelah clean clone dan mengaktifkan Node 24, dari root:

```sh
npm ci
npm run chain:init
npm run chain:start
npm run chain:health
npm --prefix smart-contract ci
npm run contracts:compile
npm run contracts:test
npm run contracts:deploy
```

Init membuat root .env yang diabaikan Git jika belum ada dan menghasilkan throwaway deployer jika key kosong. Hanya public address deployer yang diprefund di genesis. Jangan memakai wallet pribadi, mencetak key, atau memasukkannya ke frontend.

Host RPC: **http://127.0.0.1:8545**, chain ID **1337**. Container aplikasi yang bergabung ke network proyek memakai **http://rpc:8545**. MetaMask: network **RME Besu Local**, chain ID 1337, symbol **ETH** untuk mata uang development.

Kesepakatan environment: BESU_CHAIN_ID, BESU_RPC_URL, DEPLOYER_PRIVATE_KEY. Key terakhir hanya berada pada trusted deployment environment. Wallet/oracle/gateway baru harus di-approve pada account allowlist dan didanai melalui prosedur [onboarding](docs/private-chain.md#onboarding-dan-funding-development); hak aplikasi di registry diberikan terpisah.

```sh
npm run chain:stop
npm run chain:start
npm run chain:restart
```

Reset adalah operasi terpisah: `npm run chain:reset -- --confirm-delete-chain-data` **menghapus database ledger lokal**. Key/genesis/approval tetap ada; deployment serta checkpoint layanan harus diperbarui. Tidak ada reset otomatis. Lihat [panduan chain](docs/private-chain.md) untuk seluruh command, verifikasi, reset recovery, dan batas permissioning; [setup](docs/setup.md) untuk urutan lintas komponen serta troubleshooting.

Output deployment: smart-contract/deployments/1337.json; ABI arrays: smart-contract/abi/. Lihat [integrasi](docs/integration-contract.md) dan [arsitektur](docs/architecture.md). Startup frontend/oracle masih Planned.

## Lisensi

MIT, sesuai [LICENSE](LICENSE).
