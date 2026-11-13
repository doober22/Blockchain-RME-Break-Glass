# Private chain lokal

Panduan Role 1 untuk simulasi konsorsium RME dengan data sintetis. Jaringan menggunakan **Besu 26.11.0**, empat validator QBFT dan satu node RPC non-validator, chain ID **1337**, serta block period **2 detik**. Medical access control lengkap, oracle, gateway, dan frontend belum diimplementasikan. Lihat [smart contract](smart-contracts.md) untuk batas kontrak saat ini.

## Prasyarat dan versi

- Node.js **24.x** dan npm; root serta subproyek kontrak memiliki lockfile terpisah. Host pengujian masih memiliki Node 22.12.0; aktifkan Node 24 dalam shell sebelum menjalankan npm, termasuk proses turunannya.
- Docker Engine/Desktop dengan **Linux containers** dan Docker Compose. Windows menggunakan backend Linux/WSL2 Docker Desktop, bukan Windows containers. Tidak diperlukan Java, curl, Bash, atau Python pada host.
- Image `hyperledger/besu:26.11.0` dan probe sementara `node:24.22.2-alpine`; init menarik image bila belum ada. viem root dipin **2.57.16**. Solidity, Hardhat, dan dependency kontrak tetap milik subproyek.
- Lima JVM menggunakan heap maksimal 256 MiB per node, satu active processor, dan tier-1 compilation. Setiap container dibatasi satu CPU dan 768 MiB termasuk native memory. Ini pengaturan development untuk chain sintetis kecil, bukan konfigurasi benchmark atau beban produksi. Sediakan memori Docker yang memadai; hasil dan batas lingkungan pengujian dicatat di bagian validasi. Port host 8545 harus kosong.

## Instalasi dari clean clone

Dari root, setelah Node 24 aktif:

```sh
node --version
npm --version
docker info
docker compose version
npm ci
npm run chain:init
npm run chain:start
npm run chain:health
npm run chain:status
```

`chain:init` membuat root `.env` dari template jika belum ada. Jika `DEPLOYER_PRIVATE_KEY` kosong, skrip membuat key throwaway lokal tanpa mencetaknya. Jika key sudah disediakan melalui environment atau `.env`, skrip memakai identitas tersebut. Environment proses mengungguli root `.env`. Jangan memakai wallet pribadi atau aset bernilai nyata.

Init menghasilkan empat key validator menggunakan `besu operator generate-blockchain-config`, satu key RPC terpisah, genesis, static peers, permission files, dan metadata publik. Hanya address deployer yang mendapat alokasi genesis **1.000 ETH development**; key tidak dimasukkan ke genesis. Jumlah tersebut tidak memiliki nilai ekonomi.

Init ulang mempertahankan state yang sudah valid. Perubahan chain ID, deployer, subnet, host/CORS settings, genesis, key, atau konfigurasi node terhadap state awal akan ditolak. Init parsial juga ditolak: periksa direktori runtime sebelum mencoba lagi; jangan menghapus ledger yang sudah dipakai untuk melewati pemeriksaan. Ketika perintah terputus, lock `infrastructure/.chain.lock` hanya boleh dihapus setelah proses lamanya dipastikan berhenti.

## Konfigurasi dan lokasi data

| Item | Nilai/default |
| --- | --- |
| `BESU_CHAIN_ID` | `1337`; nilai lain ditolak. |
| `BESU_RPC_URL` | `http://127.0.0.1:8545`; tooling lokal juga menerima `http://localhost:8545`. |
| `DEPLOYER_PRIVATE_KEY` | Secret throwaway pada trusted environment/root `.env` yang diabaikan Git. |
| `BESU_DOCKER_SUBNET` | `172.28.133.0/24`; dapat diganti ke private IPv4 /24 sebelum init jika bentrok. |
| `BESU_HOST_ALLOWLIST` | `localhost,127.0.0.1,rpc`; harus berupa host eksplisit. |
| `BESU_CORS_ORIGINS` | localhost/127.0.0.1 pada port 3000 dan 5173, serta origin Chrome MetaMask. Tanpa wildcard. |
| Genesis | London dan Berlin aktif sejak blok 0; QBFT epoch 30.000, initial request timeout 4 detik, gas limit 30 juta, initial base fee 1 gwei. |
| Gas | Minimum inclusion gas price dan priority fee 1 gwei. RPC memakai api-gas-price-blocks=0 agar estimasi EIP-1559 tidak menghasilkan tip nol dari history kosong. |
| Compose project/network | `rme-break-glass` / `rme-break-glass_chain`. |

Subnet/IP didefinisikan sebelum init, bukan bergantung pada alamat container yang berubah. Validator memakai `.11`–`.14`, RPC `.15`. Semua node memakai static peers dan daftar node yang sama; discovery dan bootnodes publik dimatikan. P2P tidak dipublikasikan ke host.

```text
infrastructure/
  compose.yaml                # Lima service persisten
  chain.mjs, lib.mjs           # Lifecycle, konfigurasi, permissioning, health
  probe.mjs                   # Query QBFT dari loopback validator1
  verify.mjs                  # Penerimaan integrasi, transaksi, fault/persistence
  test/                       # Tes konfigurasi dan batas reset
  .runtime/                   # Seluruhnya diabaikan Git
    keys/<node>/key           # Secret per node
    nodes/<node>/             # Config dan permission files per node
    data/<node>/              # Database ledger dan static peers
    generated/               # Output operator Besu lokal, termasuk key
    genesis.json             # Alokasi publik, tanpa private key
    network.json             # Identitas publik dan hash file konfigurasi
    compose.env              # Nilai publik untuk Compose; tanpa deployer key
    validation.json          # Hasil penerimaan integrasi lokal
```

Setiap node hanya menerima mount key miliknya. Permission files dapat ditulis Besu dan diperiksa konsistensinya oleh tooling. Deployer key tidak diteruskan ke container. Jangan mencetak `.env`, memakai `docker compose config` sebagai pengganti daftar secret, atau menyalin key ke browser.

## RPC host, container, dan finality

- **Host/MetaMask:** `http://127.0.0.1:8545`, dipublikasikan hanya pada loopback host. Namespace `ETH`, `NET`, dan `WEB3` tersedia; `ADMIN`, `PERM`, `QBFT`, dan `DEBUG` tidak diaktifkan pada endpoint ini.
- **Container aplikasi:** `http://rpc:8545` setelah bergabung ke network `rme-break-glass_chain`. Di container, `localhost` menunjuk container itu sendiri. Jangan menyalin `BESU_RPC_URL` host ke layanan oracle yang berada dalam container.
- **Monitoring QBFT:** validator1 memiliki endpoint HTTP pada loopback dalam container, tanpa port host. Probe Node sementara memakai network namespace validator1 untuk memanggil `qbft_getValidatorsByBlockNumber`. Docker operator diperlukan untuk probe; endpoint ini tidak disediakan bagi frontend.

`chain:health` memeriksa `eth_chainId`, kenaikan block height dalam interval enam detik, genesis identity, dan empat address validator yang persis sesuai init. Startup menunggu maksimal lima menit; health mandiri memiliki batas sekitar dua menit, ditambah waktu RPC/probe. Docker container berstatus running saja tidak membuktikan quorum sehat.

QBFT memberikan finality pada blok yang sudah dikomit dengan quorum. Konsumen kelak harus memeriksa receipt sukses dan block identity pada chain yang benar; jangan mengasumsikan API tag `finalized` tersedia tanpa pemeriksaan. Empat validator toleran terhadap satu validator yang tidak aktif; hilangnya quorum harus menghentikan pembukaan akses baru.

## Onboarding dan funding development

Account permissioning jaringan berbeda dari role aplikasi di `ParticipantRegistry`. Approval jaringan tidak otomatis memberi hak membaca RME. Semua controlled nodes mengaktifkan node dan account allowlisting. Account baru masuk melalui perubahan file oleh operator, sehingga tidak perlu mengirim transaksi dari akun yang belum disetujui.

1. Buat wallet development di MetaMask atau trusted service environment. Catat **address publik** saja. Deployer awal otomatis ada dalam allowlist.
2. Hentikan chain dan tambahkan address pasien/dokter/oracle/gateway sesuai kebutuhan:

   ```sh
   npm run chain:stop
   npm run chain:approve -- --address ADDRESS_PUBLIK
   npm run chain:accounts
   npm run chain:start
   npm run chain:fund -- --address ADDRESS_PUBLIK --amount 1
   ```

   Ganti `ADDRESS_PUBLIK` dengan address EVM nonzero. Approval saat chain berjalan ditolak; kelima permission files harus konsisten. Funding hanya menerima recipient yang sudah approved, jumlah positif maksimal 1.000 ETH per perintah, dengan paling banyak 18 digit desimal. Skrip menunggu receipt sukses.
3. Setelah kontrak tersedia, admin mendaftarkan role, fasilitas, dan kredensial melalui mekanisme Role 2. Registrasi ini terpisah dari approval/funding jaringan.

MetaMask: network `RME Besu Local`, RPC host di atas, chain ID `1337` (`0x539`), native currency symbol **ETH** untuk saldo development. Account oracle/gateway tetap berada pada trusted service environment; jangan memasukkan key tersebut atau deployer key ke frontend.

Local permissioning membatasi controlled node, bukan menjamin kerahasiaan ledger terhadap peserta jahat. Node dapat menerima blok yang sudah memuat transaksi yang tidak ada dalam allowlist lokalnya; karena itu daftar semua controlled nodes disamakan. Pihak yang memiliki salinan ledger tetap dapat membocorkannya. Data klinis dan kunci tetap off-chain.

## Kontrak: install, compile, test, deploy

```sh
npm --prefix smart-contract ci
npm run contracts:compile
npm run contracts:test
npm run contracts:deploy
```

Root command mendelegasikan ke subproyek secara independen. Deployment memakai root environment yang sama, memverifikasi chain/genesis, bytecode, receipt, dan registry wiring. Output publik: `smart-contract/deployments/1337.json` dan ABI arrays di `smart-contract/abi/`. Menjalankan deploy kembali memverifikasi dan menggunakan ulang deployment yang cocok.

Constructor serta registry tersedia, tetapi operasi consent, break-glass, dan authorization pada controller masih `NotImplemented()`. Deployment sukses tidak membuktikan mekanisme medical access control sudah selesai.

## Stop, restart, log, dan reset

```sh
npm run chain:logs
npm run chain:stop
npm run chain:start
npm run chain:restart
```

Stop/start/restart mempertahankan key, genesis, account allowlist, dan ledger. `chain:logs` menampilkan maksimal 80 baris per node. Perintah lifecycle menggunakan lock agar tidak berjalan bersamaan.

**Perintah berikut menghapus seluruh database ledger lokal proyek:**

```sh
npm run chain:reset -- --confirm-delete-chain-data
```

Reset memvalidasi absolute path `infrastructure/.runtime/data`, menolak link atau target di luar lokasi tersebut, menjalankan Compose down untuk proyek ini, lalu menghapus direktori data saja. Key, genesis, approval, dan `.env` dipertahankan. Tidak ada reset otomatis saat init/start/restart. Setelah reset:

```sh
npm run chain:start
npm run contracts:deploy -- --redeploy
```

Anggap deployment, grant, serta checkpoint oracle/indexer lama tidak valid. Regenerasi/muat ulang manifest dan cocokkan bytecode/receipt. Chain ID dan genesis hash dapat tetap sama setelah reset karena key/genesis dipertahankan; keduanya saja tidak membuktikan deployment lama masih ada. Penghapusan identitas atau perubahan genesis bukan fungsi reset ini dan harus direncanakan terpisah.

## Pemeriksaan dan hasil

```sh
npm run chain:test
npm run chain:verify
```

`chain:verify` adalah pemeriksaan integrasi eksplisit: mengirim transaksi sintetis, mendanai test sender yang tidak diizinkan, memeriksa penolakannya, menghentikan validator4 sementara, lalu menghentikan/memulai kelima node untuk memeriksa persistence. Skrip memulihkan node dalam blok `finally`, tidak menjalankan reset, dan hanya mencetak diagnostik publik. Hasil berada di `.runtime/validation.json`.

Hasil aktual **13 November 2026**, pada Windows dengan Docker Linux backend x86_64, 8 vCPU dan sekitar 3,69 GiB RAM VM. Node sementara 24.22.2 diaktifkan pada PATH shell pengujian, npm 11.5.1, Docker 29.8.1, Compose v5.5.1. Pengujian memakai checkout ini dengan runtime baru yang diinisialisasi lokal, bukan clean clone terpisah. Startup awal mengalami contention dan timeout; batas CPU/heap serta konfigurasi fee di atas adalah konfigurasi akhir yang lulus.

Sebagian alias `chain:*` diuji melalui entry point yang sama secara langsung, yaitu `node infrastructure/chain.mjs ACTION` atau `node infrastructure/verify.mjs`, menggunakan executable Node 24 sementara. Command npm pada tabel adalah antarmuka repository untuk menjalankan entry point tersebut.

| Perintah/pemeriksaan | Hasil yang diamati |
| --- | --- |
| `npm ci --offline --ignore-scripts` pada root | Lulus dari cache setelah install awal; 13 package, audit root melaporkan 0 vulnerability. Root tidak memiliki install scripts. |
| `npm --prefix smart-contract ci` | Lulus; 65 package. npm audit melaporkan 3 high-severity vulnerabilities pada dependency kontrak; belum diaudit/diperbaiki dalam lingkup Role 1. |
| `chain:init`, kemudian init ulang | Empat key validator dihasilkan operator Besu; key RPC terpisah; identitas/deployer dipertahankan pada init ulang. |
| `chain:approve`, `chain:accounts`, `chain:fund -- --address ADDRESS --amount 1` | Approval pada lima node saat berhenti dan funding 1 ETH development lulus. Tidak diperlukan transaksi onboarding dari akun yang belum approved. |
| Pinned image `--help` | Semua 28 opsi yang dihasilkan dikenali. |
| `npm run chain:test` / Node test runner | 5 tes lulus: invalid config/address, isolasi RPC, state reuse/drift, permission consistency, dan batas reset. |
| `chain:start`, `chain:health`, `chain:verify` | Lulus pada konfigurasi akhir: ID 1337, blok 174→178, empat address validator yang sesuai init, priority fee RPC 1 gwei. |
| Transaksi approved | Receipt sukses; hash lengkap terdapat pada laporan publik. |
| Transaksi sender tidak approved tetapi didanai | Ditolak dengan RPC -32007: Sender account not authorized to send transactions; nonce tetap 0. |
| Host RPC/port bindings | Hanya 127.0.0.1:8545; ADMIN, PERM, QBFT, dan DEBUG tidak tersedia melalui endpoint host. |
| Validator4 dihentikan | Blok tetap maju 189→191 dan transaksi bertanda tangan mendapat receipt sukses. Validator dipulihkan. |
| Stop/start semua node | Blok 182 dengan hash yang sama dan receipt transaksi sebelumnya tetap ada; health akhir menunjukkan blok 201→204. |
| `npm --prefix smart-contract test` | Compile/ABI export/typecheck lulus; 21 tes Solidity (termasuk 256 fuzz runs) dan 8 tes deployment lulus. |
| `npm run contracts:deploy`, dijalankan dua kali | Deployment pertama lulus; run kedua memverifikasi dan menggunakan ulang address yang sama tanpa deployment baru. Chain/genesis, bytecode, receipt, constructor inputs, dan registry wiring diperiksa oleh tooling Role 2. |
| Secret scan dan link checks | Tidak ada generated key pada file yang akan dimasukkan Git; seluruh 30 relative links valid. |
| Reset destruktif | Tidak dijalankan pada chain kerja. Guard confirmation/path/link diuji memakai fixture sementara. |

Bukti publik yang tersimpan: [laporan penerimaan chain](validation/private-chain-2026-11-13.json) dan [manifest deployment lokal](../smart-contract/deployments/1337.json). Address serta hash adalah milik run lokal ini; init di komputer lain menghasilkan identitas berbeda. ABI arrays dihasilkan oleh script Role 2. Source kontrak dan package subproyek tidak diubah.

## Troubleshooting dan batasan

| Gejala | Tindakan |
| --- | --- |
| Node tidak didukung / `tsc` tidak ditemukan | Aktifkan Node 24 untuk npm dan child process; jalankan `npm ci` pada root dan `npm --prefix smart-contract ci`. |
| RPC tidak tersedia | Periksa Docker Linux backend, port 8545, `chain:logs`, dan `chain:health`. Startup lima JVM dapat memerlukan beberapa menit. |
| Wrong network | Cocokkan wallet, RPC, dan manifest ke 1337; jangan mengirim transaksi pada chain lain. |
| Unauthorized submission | Stop, approve address pada kelima node, start, lalu cek role aplikasi secara terpisah. |
| Saldo development kurang | Gunakan `chain:fund` dari deployer approved; alokasi genesis hanya berlaku pada chain baru. |
| Config/permission drift | Pulihkan environment dan file yang sesuai identitas init. Jangan memodifikasi satu node saja atau mereset ledger secara otomatis. |
| Subnet bentrok | Pilih private /24 lain sebelum init. Identitas init tidak ditulis ulang secara diam-diam. |
| Grant/bytecode lama setelah reset | Deploy ulang secara eksplisit, reload artifacts, dan reset checkpoint layanan sesuai prosedurnya. |
| Quorum hilang / blok tidak maju | Pulihkan validator dan tunggu health sukses; aplikasi tidak boleh membuka akses baru. |

Lima container pada satu host hanya menyimulasikan konsorsium. Belum membuktikan independensi organisasi, availability lintas fasilitas, atau keunggulan security/latency terhadap SATUSEHAT. Event otorisasi juga tidak membuktikan record berhasil dikirim.

Rujukan yang dipakai: [rilis Besu 26.11.0](https://github.com/besu-eth/besu/releases/tag/26.11.0), [QBFT setup](https://docs.besu-eth.org/private-networks/tutorials/qbft), [local permissioning](https://docs.besu-eth.org/private-networks/how-to/use-local-permissioning), dan [configuration options](https://docs.besu-eth.org/public-networks/reference/options). Seluruh opsi yang dihasilkan juga diperiksa terhadap `--help` image yang dipin.
