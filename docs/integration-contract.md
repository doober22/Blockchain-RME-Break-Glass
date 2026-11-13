# Kontrak integrasi antarkomponen

Dokumen ini membedakan **kesepakatan target** dari implementasi. Belum ada chain proyek, deployment, ABI publik, atau layanan frontend/oracle yang berjalan.

## Network, environment, dan artifacts

| Item | Kesepakatan | Kondisi repository |
| --- | --- | --- |
| Chain ID | 1337 (wallet JSON-RPC: `0x539`) | Config membaca `BESU_CHAIN_ID`; genesis belum ada. |
| Host RPC | `http://127.0.0.1:8545` | Default config, service belum tersedia. |
| Container RPC | Endpoint internal dari Role 1 | Belum ditentukan; jangan memakai loopback host sebagai service container. |
| Environment bersama | `BESU_CHAIN_ID`, `BESU_RPC_URL`, `DEPLOYER_PRIVATE_KEY` | Dua key pertama dibaca config; deployer key belum digunakan, `accounts: []`. |
| Scripts kontrak | `compile`, `test`, `deploy:besu` | Hanya `compile` tersedia. |
| Address manifest | `smart-contract/deployments/1337.json` | Belum tersedia. |
| ABI | `smart-contract/abi/` | Belum tersedia; Role 2 perlu menetapkan nama file dan bentuk ekspor. |

Manifest harus memiliki `chainId` numerik 1337, `contracts.ParticipantRegistry`, `contracts.MedicalAccessController` berupa address EVM nonzero, serta `deploymentTransactions`. Bentuk/encoding `deploymentTransactions` belum disepakati: scaffold mempertahankannya sebagai `unknown`, bukan mengarang format hash/receipt. Role 2 harus menetapkannya sebelum validasi receipt diintegrasikan. Semua artifact harus berasal dari deployment/build yang sama.

Frontend kelak menyalin **hanya** manifest publik dan dua ABI yang diperlukan ke asset build. Jangan mengimpor root environment, script deployment, atau artifact yang memuat secret. `frontend/integration.ts` memvalidasi manifest serta chain ID wallet dan RPC sebelum address digunakan. Helper belum memeriksa bytecode, receipt, ABI, atau checksum address; implementer viem harus menambahkan validasi artifact dan deployment serta mengulang guard pada `chainChanged`, perubahan RPC, dan sebelum aksi. Gagal/mismatch harus memblokir aksi, tanpa fallback jaringan.

## Oracle: event → API → transaksi (Planned)

1. Dengarkan `EmergencyRequested(requestId, patient, clinician, facilityId, requestHash, deadline)` dari address kontrak yang tervalidasi, tunggu finality QBFT sesuai kebijakan Role 1, dan simpan checkpoint. Jangan berasumsi tag RPC `finalized` tersedia tanpa pengujian Besu.
2. Ambil `getRequest(requestId)` dan record scope dari sumber kontrak yang disepakati Role 2. Event saat ini tidak membawa encounter ID atau record list; getter masih me-revert dan tidak ada getter daftar record. Role 2 perlu menentukan cara memperoleh/verifikasi scope tanpa menebak hash encoding.
3. Query API fasilitas sintetis berdasarkan encounter. API dikelola independen dari form emergency dokter. Sumber/endpoint harus dipilih dari konfigurasi fasilitas tepercaya, bukan URL bebas dari pemohon.
4. Validasi response dan binding pasien, dokter, fasilitas, encounter, evidence commitment, request hash, chain ID, dan address kontrak. Pastikan request pending, belum deadline, serta kredensial aktif. Kondisi `encounterActive`, `emergency`, `patientUnableToConsent`, dan `clinicianAssigned` harus benar untuk approval.
5. Kirim `resolveEmergency(uint256 requestId, bool approved, bytes32 requestHash, uint64 observedAt, uint64 validUntil)` melalui akun oracle berwenang untuk fasilitas, lalu cek receipt final. Metode ini tersedia sebagai signature skeleton, bukan implementasi. Status grant harus dibaca dari chain, bukan diasumsikan dari HTTP response.

### Mock endpoint proyek

`GET /api/v1/encounters/{encounterId}/emergency-context` adalah **rancangan mock API proyek**, bukan endpoint SATUSEHAT. Gunakan data sintetis saja. Tipe field di `oracle/emergency-context.ts` adalah kontrak handoff TypeScript, bukan validator runtime atau server.

| Field | Bentuk yang diusulkan | Arti |
| --- | --- | --- |
| `encounterId` | string hex bytes32 | ID encounter acak sintetis; cocok dengan path dan request. |
| `patientWallet` | string address EVM | Pasien dalam request. |
| `clinicianWallet` | string address EVM | Dokter pemohon. |
| `facilityId` | string hex bytes32 | Fasilitas pemohon yang terverifikasi. |
| `encounterActive` | boolean | Encounter masih berlangsung. |
| `emergency` | boolean | Konteks darurat dari fasilitas. |
| `patientUnableToConsent` | boolean | Ketidakmampuan memberi consent dari fasilitas. |
| `clinicianAssigned` | boolean | Dokter ditugaskan pada encounter. |
| `evidenceCommitment` | string hex bytes32 | Komitmen bukti sintetis; cocok dengan request. |
| `observedAt` | integer Unix seconds | Waktu observasi, bukan milliseconds. |
| `validUntil` | integer Unix seconds | Batas validitas observasi. |

Encoding bytes32 di atas adalah usulan handoff agar selaras dengan signature Solidity, belum spesifikasi server yang berjalan. Tidak perlu membuat contoh bukti klinis atau private key.

### Persyaratan worker berikutnya — belum diimplementasikan

- Schema validation runtime: exact types, ukuran hex, address, timestamp safe integer, dan batas ukuran response; TypeScript saja tidak memvalidasi JSON.
- Authenticated API access, pengikatan fasilitas, dan transport aman di luar localhost; secret layanan tetap di trusted worker environment.
- Freshness: tolak timestamp masa depan/usang; target `observedAt <= waktu validasi < validUntil`, usia dan validity window maksimal 60 detik, serta deadline request maksimal 120 detik. Verifikasi ulang terhadap waktu chain saat transaksi; sinkronisasi jam dan margin pengiriman masih perlu diimplementasikan.
- Request binding dan canonical hash/attestation encoding harus dikonfirmasi Role 2; jangan merakit hash dari JSON arbitrer.
- Timeout, malformed response, mismatch, atau sumber tak terautentikasi tidak menghasilkan approval. Retry harus terbatas oleh jumlah/waktu dan deadline, tanpa memperpanjang grant atau membuat approval default.
- Idempotency/checkpoint berdasarkan chain, contract address, request ID, dan event identity; cek status on-chain sebelum retry setelah crash/receipt tak pasti. Kontrak tetap harus menolak keputusan ganda. Nilai timeout/retry dan kebijakan finality ditetapkan saat worker dibangun.

## Handoff yang memblokir integrasi

**Role 1:** Compose/genesis, Besu pin dan fork schedule, permissioning, host/container RPC, template environment dan pemuatannya, akun/funding development, kebijakan finality/health, serta perintah init/start/stop/restart/reset dengan target data yang dihapus.

**Role 2:** implementasi dan test kontrak, constructor deployable, signer deployment, `test`/`deploy:besu`, manifest/ABI dan format transaksi, cara memperoleh scope request, canonical request/attestation hashes, serta panduan registrasi akun/peran. Role 3 tidak mengubah file milik kedua role tersebut.
