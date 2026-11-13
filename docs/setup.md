# Setup lintas komponen

Gunakan [panduan private chain](private-chain.md) sebagai sumber command infrastruktur dan [panduan kontrak](smart-contracts.md) sebagai sumber perilaku Solidity. Data dan akun seluruhnya untuk development sintetis.

## Prasyarat

Node.js **24.x**, npm, Docker Engine/Desktop dengan Linux containers dan Compose. Besu dipin **26.11.0**; probe sementara **node:24.22.2-alpine**. Root viem **2.57.16** memiliki lockfile sendiri. Subproyek memakai Hardhat **3.21.1**, viem **2.57.16**, TypeScript **5.9.3**, Solidity **0.8.28**, dan OpenZeppelin **5.6.1**. Target EVM kontrak adalah paris; genesis chain mengaktifkan London. Kompatibilitas dinilai melalui deployment aktual, bukan nama fork saja.

Jika Node sistem masih 22.12.0, aktifkan Node 24 untuk npm beserta child process tanpa harus mengganti instalasi sistem. Memanggil npm dengan Node 24 tetapi membiarkan child process memakai Node 22 tetap menyebabkan Hardhat gagal.

## Urutan clean-clone

Dari root setelah clone:

```sh
node --version
npm --version
docker info
docker compose version
npm ci
npm run chain:init
npm run chain:start
npm run chain:health
npm --prefix smart-contract ci
npm run contracts:compile
npm run contracts:test
npm run contracts:deploy
```

Init menghasilkan .env lokal dari [.env.example](../.env.example) bila perlu. DEPLOYER_PRIVATE_KEY kosong diisi key throwaway lokal dan tidak dicetak; key yang sudah disediakan akan digunakan ulang. Jangan menyimpan key dalam source, browser config, atau log.

| Key | Pemakaian |
| --- | --- |
| BESU_CHAIN_ID | 1337, divalidasi oleh tooling infrastruktur dan kontrak. |
| BESU_RPC_URL | Host http://127.0.0.1:8545. |
| DEPLOYER_PRIVATE_KEY | Trusted deployer, diprefund dengan 1.000 ETH development saat genesis dibuat. |
| BESU_DOCKER_SUBNET | Private /24, default 172.28.133.0/24; tetapkan sebelum init. |
| BESU_HOST_ALLOWLIST / BESU_CORS_ORIGINS | Host/origin eksplisit sebelum init; default development dijelaskan di panduan chain. |

Tooling kontrak sekarang memuat environment proses, root .env, kemudian smart-contract/.env dengan nilai yang sudah ada tetap diprioritaskan. Config signer juga sudah tersedia. Ini menggantikan kondisi lama ketika config memakai accounts kosong.

## Wallet, onboarding, dan artifacts

MetaMask: RME Besu Local, RPC http://127.0.0.1:8545, chain ID 1337 (0x539), symbol lokal ETH. Jangan memakai seed wallet pribadi. Menambah network tidak otomatis memberi permission, saldo gas, atau role aplikasi.

Untuk approved-account onboarding: stop chain → `chain:approve -- --address ADDRESS_PUBLIK` → start/health → `chain:fund -- --address ADDRESS_PUBLIK --amount 1`. Lihat [prosedur lengkap](private-chain.md#onboarding-dan-funding-development). Oracle dan gateway memakai akun layanan terpisah; secret tidak masuk frontend.

Deployment menghasilkan manifest smart-contract/deployments/1337.json dengan dua address, deployment transaction hashes, genesis hash, deployer/admin, serta artifact hashes. ABI arrays tersedia pada [ParticipantRegistry](../smart-contract/abi/ParticipantRegistry.json) dan [MedicalAccessController](../smart-contract/abi/MedicalAccessController.json). Manifest aktual bersifat lokal, sehingga dokumen menunjuk [spesifikasi deployment](../smart-contract/deployments/README.md).

Deploy ulang tanpa flag memverifikasi/menggunakan ulang deployment yang cocok. Setelah reset atau mismatch, gunakan `npm run contracts:deploy -- --redeploy`, kemudian reload consumers. Verifikasi receipt, bytecode, dan registry wiring; format address saja tidak membuktikan deployment valid.

## Stop, restart, dan reset

```sh
npm run chain:stop
npm run chain:start
npm run chain:restart
```

Perintah tersebut mempertahankan ledger. **Hanya** `npm run chain:reset -- --confirm-delete-chain-data` yang menghapus infrastructure/.runtime/data setelah memvalidasi path dan menghentikan proyek. Key, genesis, approvals, dan .env dipertahankan. Sesudahnya start chain, deploy ulang secara eksplisit, dan perbarui checkpoint oracle/indexer. Chain ID/genesis hash yang sama tidak menjamin kontrak lama masih ada.

## Apa yang belum berjalan

ParticipantRegistry dan constructors/getter metadata controller tersedia. Metode consent, request/resolve break-glass, authorization, dan review controller masih me-revert NotImplemented(). Tidak ada frontend/oracle package atau start script. Mock API, gateway, encrypted storage/key service, audit indexer, demo/video, dan panduan use-case medis end-to-end masih Planned; belum ada URL demo.

## Troubleshooting

| Gejala | Pemeriksaan/tindakan |
| --- | --- |
| Wrong network | Cocokkan wallet, RPC, serta manifest ke 1337; block aksi saat mismatch. |
| RPC unavailable | Periksa Docker Linux backend, port 8545, chain:logs, dan chain:health. Host memakai loopback, container memakai rpc:8545 pada network proyek. |
| Unauthorized account | Approve public address pada semua node dengan chain berhenti. Role/fasilitas/kredensial aplikasi diperiksa terpisah. |
| Development balance kurang | Gunakan chain:fund dari deployer approved. Funding bukan permission aplikasi. |
| Dependency tidak kompatibel | Aktifkan Node 24 pada PATH, lalu npm ci pada root dan subproyek. |
| NotImplemented() | Operasi controller masih stub; bukan masalah MetaMask atau chain. |
| Config/permission drift | Pulihkan nilai/file sesuai init dan samakan daftar semua node; jangan otomatis menghapus ledger. |
| Address stale setelah reset | Redeploy eksplisit dan verifikasi bytecode/receipt; reload manifest/ABI/checkpoint. |

## Hasil verifikasi

Pemeriksaan ulang **13 November 2026** lulus: 5 tes infrastruktur, 21 tes Solidity (termasuk 256 fuzz runs), 8 tes deployment lokal, dan deployment kedua kontrak ke Besu. Chain acceptance membuktikan sender tidak approved yang sudah didanai ditolak, transaksi tetap berhasil dengan satu validator berhenti, serta blok/receipt bertahan setelah stop/start.

Hasil lengkap beserta versi, command, dan batas lingkungan tersedia pada [panduan chain](private-chain.md#pemeriksaan-dan-hasil), [bukti publik](validation/private-chain-2026-11-13.json), dan [manifest deployment](../smart-contract/deployments/1337.json). Root npm audit melaporkan 0 vulnerability; instalasi dependency kontrak melaporkan 3 high-severity vulnerabilities yang perlu ditinjau Role 2. Tidak ada audit fix atau perubahan dependency subproyek dalam tahap ini.

Pengujian ledger tidak membuktikan kebenaran medis atau record delivery. Operasi controller yang masih stub dan seluruh runtime layanan tetap Planned.
