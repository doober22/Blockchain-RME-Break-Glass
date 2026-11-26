# Kontrak integrasi antarkomponen

Dokumen ini mencatat implementasi infrastruktur/kontrak saat ini serta rancangan layanan yang masih Planned.

## Network, environment, dan artifacts

| Item | Kesepakatan dan kondisi |
| --- | --- |
| Chain ID | 1337; wallet JSON-RPC 0x539. Tooling menolak chain ID lain. |
| Host RPC | http://127.0.0.1:8545, namespace ETH/NET/WEB3, loopback host. |
| Container RPC | http://rpc:8545 pada network rme-break-glass_chain; bukan localhost milik container oracle. |
| Environment bersama | BESU_CHAIN_ID, BESU_RPC_URL, DEPLOYER_PRIVATE_KEY. Root .env dibuat oleh init jika perlu; key hanya di trusted environment. |
| Scripts kontrak | compile, test, deploy:besu, export:abi, typecheck, deployer:address tersedia. Root mendelegasikan melalui contracts:*. |
| Address manifest | smart-contract/deployments/1337.json, dihasilkan deployment yang terverifikasi. |
| ABI | smart-contract/abi/ParticipantRegistry.json dan MedicalAccessController.json, masing-masing ABI array publik. |
| Onboarding | Operator stop → approve address di kelima node → start/health → fund. Role registry terpisah. |

Manifest schemaVersion 1 berisi chainId, genesisHash, deployer, initialAdmin, contracts.ParticipantRegistry, contracts.MedicalAccessController, deploymentTransactions yang dipetakan ke hash transaksi per nama kontrak, serta artifactHashes. Format ini sekarang dikirim Role 2; lihat [spesifikasi deployment](../smart-contract/deployments/README.md). Jangan menganggap schema masih belum ditentukan.

Frontend hanya boleh menyalin manifest publik dan dua ABI ke build assets. Helper frontend memeriksa chain ID wallet/RPC dan address nonzero; deploymentTransactions pada tipe scaffold masih unknown sehingga belum memvalidasi schema baru secara lengkap. Integrasi viem berikutnya harus memvalidasi schemaVersion, hash, receipt, code, dan kesesuaian artifact. Ulangi guard saat chainChanged, perubahan RPC, serta sebelum aksi. Jangan mengimpor root .env, deployment scripts, atau service/encryption secrets ke browser.

## Consent dan authorization normal (implemented; runtime gateway Planned)

Controller source sekarang mengimplementasikan record lifecycle, consent normal, request/resolution emergency, scope/status getter, serta query/authorization kedua mode. Mode publik: `NORMAL_MODE() = 0`, `EMERGENCY_MODE() = 1`. Mode emergency hanya mengizinkan grant ACTIVE yang sesuai scope/dokter/kredensial/fasilitas dan belum expiry; pending/rejected/expired ditolak. Closure/review masih stub. Manifest 1337 yang tersimpan masih deployment skeleton historis; ABI source terbaru harus dipasangkan dengan deployment baru yang diverifikasi, bukan diasumsikan cocok dengan address lama.

Pasien pemilik record aktif memberi consent untuk satu dokter, satu record, dan expiry Unix seconds di masa depan. Keduanya harus eligible; fasilitas penerbit aktif. Consent normal boleh lintas fasilitas. Pasien asli dapat mencabut consent walaupun kredensial/role-nya sudah tidak aktif. Consent baru mempunyai ID baru; pencabutan tidak menghapus metadata lama.

`canRead(clinician, recordId, mode, grantId)` adalah query publik yang memeriksa policy terkini, bukan bukti penguasaan wallet. Runtime gateway kelak harus memverifikasi challenge wallet dokter, memeriksa query, lalu mengirim `authorizeAccess` sebagai gateway eligible fasilitas penerbit record. Kontrak memeriksa ulang policy saat eksekusi; query true tidak menjamin transaksi berikutnya berhasil. Expiry bersifat eksklusif: akses ditolak pada `block.timestamp >= expiresAt`.

`accessId` harus bytes32 nonzero baru untuk setiap otorisasi dan unik lintas record/grant/gateway dalam satu instance controller. Hanya transaksi sukses yang memakai ID dan emit `AccessAuthorized`; transaksi gagal tidak meninggalkan event. Setelah receipt final sukses, gateway tetap harus memeriksa ulang status terkini, menguji ciphertext, dan mencatat outcome pengiriman off-chain. Implementasi HTTP, wallet challenge, enkripsi, dan delivery log masih Planned. Lihat [panduan kontrak](smart-contracts.md#normal-consent-and-read-authorization) untuk error, policy, dan bukti tes.

## Oracle: event → API → transaksi (Planned)

1. Dengarkan EmergencyRequested(requestId, patient, clinician, facilityId, requestHash, deadline) dari address tervalidasi pada chain 1337. Tunggu blok QBFT yang sudah dikomit dan receipt sukses; implementer harus menguji dukungan RPC finality/tag sebelum mengandalkannya.
2. Baca `getRequest(requestId)`, periksa exists, lalu baca `getRequestRecords(requestId)` untuk scope maksimal 20 record. Pembuatan request, resolution, scope getter, hash request/attestation, serta effective expiry sudah diimplementasikan pada kontrak. Event tidak membawa encounter ID maupun record list, sehingga ambil keduanya dari getter. Getter scope/status menolak ID tidak dikenal dengan `RequestNotFound`.
3. Query mock hospital API berdasarkan encounter dari sumber fasilitas tepercaya. API dikelola independen dari input dokter; jangan memakai URL bebas dari pemohon.
4. Validasi schema, autentikasi, freshness, serta binding pasien, dokter, fasilitas, encounter, evidence commitment, request hash, chain ID, dan contract address. Request harus pending/belum deadline, kredensial aktif, dan semua indikator emergency yang diwajibkan benar.
5. Kirim `resolveEmergency(uint256 requestId, bool approved, bytes32 requestHash, uint64 observedAt, uint64 validUntil)` melalui oracle eligible fasilitas pemohon, lalu periksa receipt final dan event/state. Metode kontrak sudah diimplementasikan; HTTP worker belum ada dan approval API saja bukan grant on-chain. Recheck status sebelum retry: keputusan kedua ditolak.

### Binding request yang sudah diimplementasikan

Dokter dan pasien harus eligible saat request dibuat. Record IDs harus nonzero, strictly increasing menurut nilai numerik bytes32, unik, berjumlah 1–20, aktif, dan milik pasien; fasilitas penerbit aktif. Pemohon mengurutkan ID sebelum mengirim transaksi, tanpa mengubah scope yang dipilih. Durasi 1–900 detik; encounter/evidence commitment dan reason code wajib nonzero. Fasilitas pemohon diturunkan dari registry dokter. Request berstatus PENDING dan effective expiry mulai `block.timestamp >= decisionDeadline`, dengan deadline 120 detik sejak pembuatan. Tidak ada grant dari submission saja.

Gunakan `hashEmergencyRequest` dari `smart-contract/integration/request-hash.ts`, utilitas viem tanpa signer/environment. Hash adalah `keccak256(abi.encode(binding))`, **satu tuple dinamis**, dengan schema tepat:

```text
(uint256 chainId, address controller, uint256 requestId,
 address patient, address clinician, bytes32 requesterFacilityId,
 bytes32 encounterId, bytes32[] recordIds, uint16 reasonCode,
 bytes32 evidenceCommitment, uint64 requestedDuration, uint64 decisionDeadline)
```

Ambil chain ID/address dari deployment terverifikasi serta ID/deadline/field request/scope dari chain. Helper memakai bigint untuk integer selain reasonCode (number), memvalidasi batas/order, dan tidak melakukan sorting otomatis. Jangan memakai packed encoding, JSON hashing, atau daftar argumen flat untuk hash request ini. Vector tetap dan tes hash lintas bahasa tersedia; detail di [panduan kontrak](smart-contracts.md#pending-emergency-requests-and-request-binding). Hash request tidak membuktikan kebenaran fakta klinis.

### Keputusan oracle dan attestation (kontrak implemented; worker Planned)

Resolution positif maupun negatif memerlukan oracle eligible fasilitas pemohon, request tersimpan PENDING, eksekusi sebelum deadline, hash cocok, `observedAt <= block.timestamp < validUntil`, usia maksimal 60 detik, serta window `0 < validUntil - observedAt <= 60`. Timestamp memakai Unix seconds. Jangan memperbarui observedAt hanya karena fetch/retry. Kombinasi expiry eksklusif dan window 60 detik membuat observasi yang tepat berusia 60 detik tidak lagi valid.

Approval memeriksa ulang pasien, dokter beserta afiliasi pemohon yang sama, dan seluruh record aktif/fasilitas penerbit. Aktivasi dan expiry dihitung dari waktu blok keputusan. Rejection menetapkan REJECTED tanpa aktivasi; dapat diterima setelah pasien/dokter dinonaktifkan selama oracle dan keputusan tetap memenuhi syarat. Error yang menolak transaksi tidak menghasilkan rejection atau grant; request tetap pada state sebelumnya. Keputusan yang sudah diterima tidak boleh dikirim ulang.

Kontrak menghitung hash attestation dari **tujuh argumen ABI flat**, berbeda dari tuple dinamis hash request:

```text
keccak256(abi.encode(uint256 chainId, address controller, uint256 requestId,
  bytes32 requestHash, bool approved, uint64 observedAt, uint64 validUntil))
```

Gunakan `hashEmergencyAttestation` dari `smart-contract/integration/attestation-hash.ts` untuk rekonsiliasi nilai event/storage. Tidak ada signature attestation kedua; tanda tangan transaksi oracle dan role/fasilitas pemanggil menjadi otentikasi on-chain. Helper memvalidasi bentuk/window, bukan chain freshness atau kebenaran data API. Detail error/vector di [panduan kontrak](smart-contracts.md#oracle-resolution-and-emergency-read-authorization).

Gateway kelak memakai mode 1 untuk emergency dan ID request sebagai grantId. Setiap baca memeriksa scope, dokter, afiliasi pemohon asli, kredensial terkini, record/fasilitas aktif, dan `block.timestamp < expiresAt`. Attestation yang sudah expiry tidak menghentikan grant yang telah aktif dan belum berakhir. Consent normal dan emergency independen; accessId tetap unik lintas kedua mode. Pencabutan oracle menghentikan keputusan baru, tidak otomatis menutup grant terdahulu. Closure eksplisit dan review menyusul Chunk 5.

### Mock endpoint proyek

GET /api/v1/encounters/{encounterId}/emergency-context adalah **rancangan mock API proyek**, bukan endpoint SATUSEHAT. Semua data sintetis. Tipe di oracle/emergency-context.ts bukan runtime validator atau server.

| Field | Bentuk yang diusulkan | Makna |
| --- | --- | --- |
| encounterId | string hex bytes32 | ID encounter acak; cocok dengan path dan request. |
| patientWallet | string address EVM | Pasien dalam request. |
| clinicianWallet | string address EVM | Dokter pemohon. |
| facilityId | string hex bytes32 | Fasilitas pemohon. |
| encounterActive | boolean | Encounter masih berlangsung. |
| emergency | boolean | Konteks darurat dari fasilitas. |
| patientUnableToConsent | boolean | Pasien tidak mampu memberi consent. |
| clinicianAssigned | boolean | Dokter ditugaskan pada encounter. |
| evidenceCommitment | string hex bytes32 | Komitmen bukti sintetis, cocok dengan request. |
| observedAt | integer Unix seconds | Waktu observasi, bukan milliseconds. |
| validUntil | integer Unix seconds | Batas validitas observasi. |

### Persyaratan worker berikutnya

Runtime worker masih Planned: schema validation response; authenticated API access dan transport aman di luar localhost; binding fasilitas; validasi freshness sebelum submission; serta penghentian retry sebelum request deadline. Canonical request/attestation encoding, deadline, role/facility binding, dan validasi timestamp on-chain sekarang tersedia seperti di atas. Hal tersebut tidak menggantikan verifikasi fakta/authentication sumber API oleh worker.

Timeout, response rusak/usang, mismatch, atau sumber tidak terautentikasi tidak boleh menghasilkan approval. Retry harus terbatas oleh jumlah/waktu/deadline. Checkpoint dan idempotency memakai chain, contract, request, serta event identity; cek status on-chain sebelum retry setelah crash atau receipt tidak pasti. Kontrak tetap perlu menolak keputusan ganda.

## Handoff berikutnya

**Role 1:** command lifecycle, onboarding, host/container RPC, reset recovery, dan hasil penerimaan tersedia pada [panduan chain](private-chain.md). Allowlists jaringan bukan role aplikasi.

**Role 2:** selesaikan closure, review, overdue query, dan verifikasi release. Registry, record lifecycle, consent/authorization normal, request/resolution/authorization emergency, scope/status getter, canonical request/attestation hashes, tests, signer, manifest schema, serta ABI exporter sekarang tersedia pada source. Deploy ulang terverifikasi masih diperlukan untuk source terbaru.

**Role 3/implementer layanan:** integrasikan manifest schema baru, wallet/viem, worker dengan runtime validation/checkpoints, gateway, encrypted storage/key service, indexer/notifikasi, dan demo use-case. Semua komponen tersebut tetap Planned sampai implementasi serta pengujiannya tersedia.
