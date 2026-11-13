# Blockchain RME Break-Glass

Draft milestone IF4035 Blockchain — Kelompok 6. Proyek ini merancang access control untuk Rekam Medis Elektronik (RME): akses normal melalui patient consent dan akses darurat melalui break-glass yang diverifikasi oracle. Semua pasien, encounter, dan record menggunakan data sintetis; prototipe tidak terhubung ke SATUSEHAT produksi.

SATUSEHAT sudah menyediakan emergency consent. Kontribusi yang diusulkan adalah otorisasi terdesentralisasi dan audit trail bersama antaranggota konsorsium. Belum ada pengukuran komparatif yang membuktikan peningkatan security atau latency terhadap SATUSEHAT.

## Status milestone

Status berdasarkan inspeksi repository dan hasil validasi pada [setup](docs/setup.md). **Repository ini belum menyediakan dApp atau jaringan Besu yang dapat dijalankan end-to-end.**

| Bagian | Status | Bukti dan batasan |
| --- | --- | --- |
| Struktur empat direktori dan lisensi MIT | Implemented and verified | `frontend/`, `smart-contract/`, `oracle/`, `docs/`, serta [LICENSE](LICENSE) tersedia. |
| Dokumentasi dan scaffold integrasi Role 3 | Implemented and verified | Pemeriksaan 12 relative links, TypeScript, dan kasus guard lokal lulus. Ini bukan verifikasi integrasi jaringan. |
| Source skeleton Solidity | Implemented and verified | Dua source berhasil di-compile dengan Node 24.22.2 dan solc 0.8.28. Constructor `ParticipantRegistry` dan metode bisnis kedua kontrak melakukan `revert NotImplemented()`. Ini belum merupakan mekanisme otorisasi. |
| Konfigurasi koneksi Hardhat ke Besu | Implemented but unverified | Config network tersedia, tetapi belum diuji terhadap chain proyek; `accounts: []` dan signer belum terpasang. |
| Besu private chain, QBFT, permissioning, dan orchestration | Planned | Belum ada Compose, genesis, environment template, atau skrip chain. |
| Pengujian kontrak, deployment, address manifest, dan ekspor ABI | Planned | Hanya script `compile` tersedia; `test/` dan `scripts/` berisi placeholder. |
| Patient consent, break-glass, dan review fungsional | Planned | Belum ada implementasi aturan, pengujian perilaku, atau deployment. |
| Frontend TypeScript/viem/MetaMask dan worker oracle | Planned | Hanya scaffold integrasi; tidak ada package/start script atau layanan berjalan. |
| Mock hospital API, gateway, encrypted storage/key service, audit indexer | Planned | Masih rancangan komponen off-chain. |
| Demo/video dan panduan use-case yang dapat dieksekusi | Planned | Belum ada rekaman atau URL demo. Panduan instalasi masih parsial dan memiliki blocker. |

## Masalah dan rancangan solusi

Pertukaran RME membutuhkan kewenangan tenaga medis yang dapat diverifikasi, scope akses yang jelas, dan pertanggungjawaban saat pasien tidak mampu memberi consent. Private consortium blockchain diusulkan agar fasilitas yang dikenal dapat berbagi verifikasi kebijakan dan ledger audit tanpa menaruh data klinis di public chain. Pembatasan peserta tetap membutuhkan permissioning jaringan serta access control aplikasi yang belum diimplementasikan.

Alur berikut merupakan **rancangan**, bukan fitur yang sudah berjalan:

1. **Normal:** admin mendaftarkan identitas/wallet dan fasilitas; fasilitas mendaftarkan metadata record. Pasien memberi consent untuk dokter, record, dan expiry tertentu. Gateway membuktikan wallet dan memeriksa otorisasi final sebelum melayani baca. Pasien dapat mencabut consent.
2. **Darurat:** dokter aktif meminta record terpilih untuk encounter tertentu. Request tidak membuka data. Oracle menunggu event final, mengambil konteks dari API fasilitas sintetis yang dikelola independen dari input dokter, lalu mengirim keputusan terikat pada request. Kontrak direncanakan memberi akses read-only dengan expiry; gateway memeriksa ulang scope, kredensial, dan status sebelum setiap akses.
3. **Setelah akses:** pasien mendapat riwayat/notifikasi dan auditor melakukan review. Penutupan, expiry, atau pencabutan menghentikan akses berikutnya; data yang sudah diterima tidak dapat ditarik kembali.

Parameter rancangan awal: durasi darurat maksimal 15 menit, usia attestation maksimal 60 detik, deadline request 120 detik, maksimal 20 record/request, dan target review 24 jam. Konstanta terdapat pada skeleton, tetapi penegakannya masih Planned. Ini parameter eksperimen, bukan standar klinis.

Prinsip least privilege memisahkan pasien, dokter, admin, oracle, gateway, dan auditor. Metadata minimum dan audit trail direncanakan on-chain; ciphertext, kunci, pemetaan identitas, dan fakta klinis tetap off-chain. Hash mendukung integrity ciphertext, bukan kebenaran diagnosis. Lihat [arsitektur dan keterbatasan](docs/architecture.md).

## Struktur dan ownership

```text
frontend/                     # Role 3: konvensi konsumsi address/ABI dan guard jaringan
  README.md
  integration.ts
smart-contract/               # Role 2: Solidity dan tooling Hardhat
  contracts/                  # ParticipantRegistry, MedicalAccessController (skeleton)
  scripts/                    # Placeholder deployment/seed
  test/                       # Placeholder pengujian
  hardhat.config.ts
  package.json
  package-lock.json
oracle/                       # Role 3: kontrak data dan rancangan worker
  README.md
  emergency-context.ts
docs/
  setup.md                    # Role 3: setup, blocker, dan hasil validasi
  architecture.md             # Role 3: komponen dan trust boundaries
  integration-contract.md     # Role 3: kesepakatan antarkomponen
LICENSE
README.md                     # Role 3
```

Role 1 memiliki infrastruktur, root orchestration, root environment template, `.gitignore`, serta `docs/private-chain.md` (belum tersedia). Role 2 memiliki `smart-contract/` dan `docs/smart-contracts.md` (belum tersedia). Role 3 memiliki README root, scaffold frontend/oracle, dan tiga dokumen di atas. Path deployment/ABI yang disepakati belum tersedia; lihat [kontrak integrasi](docs/integration-contract.md).

## Setup yang tersedia sekarang

Gunakan Node.js **24.x** (`engines`: `>=24.0.0 <25`) dan npm. Lockfile mengunci Hardhat **3.21.1**; package menyatakan `^3.0.0`. OpenZeppelin **5.6.1**, Solidity **0.8.28**, optimizer 200 runs, target EVM **paris**. Versi Besu dan viem belum dipin. Docker Engine/Desktop dengan Compose diperlukan untuk tahap chain yang masih Planned; MetaMask diperlukan untuk integrasi wallet mendatang.

Dari clean clone repository ini, setelah mengaktifkan Node 24:

```sh
node --version
npm --version
cd smart-contract
npm ci
npm run compile
```

Compile memeriksa source, bukan membuktikan access control berjalan. Tidak tersedia perintah `test` atau `deploy:besu`. Chain initialization/start/health, deployment, serta verifikasi address/ABI **blocked** menunggu Role 1/2; tidak ada perintah start frontend/oracle. Ikuti [urutan setup lengkap dan troubleshooting](docs/setup.md) untuk blocker, environment, stop/restart/reset, dan onboarding akun.

Konfigurasi MetaMask yang **direncanakan**: network name `RME Besu Local`, host RPC `http://127.0.0.1:8545`, chain ID **1337** (`0x539`), label native currency lokal **DEV** (label tampilan, tanpa nilai ekonomi). Endpoint container belum ditentukan Role 1; `127.0.0.1` di container menunjuk container itu sendiri. Akun harus berupa throwaway development wallet, mendapat approval jaringan/peran dan funding dari prosedur Role 1/2 yang belum tersedia. Menambah network di MetaMask tidak otomatis memberi kewenangan.

Kesepakatan environment: `BESU_CHAIN_ID`, `BESU_RPC_URL`, dan `DEPLOYER_PRIVATE_KEY`. Secret deployer hanya di trusted deployment environment; konfigurasi sekarang belum menggunakan signer tersebut. Jangan memasukkan deployment/oracle/gateway/encryption secrets ke browser, source, log, atau commit.

## Lisensi

MIT, sesuai [LICENSE](LICENSE) yang sudah ada.
