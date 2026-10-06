# Phase 3 — Thị trường điện P2P trên Hardhat

**Cập nhật smart contract 03/10/2026:** xem [SMART_CONTRACT_FEATURES.md](SMART_CONTRACT_FEATURES.md). Khớp lệnh giữ tiền chờ xác nhận giao điện; bổ sung uy tín, đặt cọc và ưu tiên cùng giá. Mô tả thanh toán ngay khi kết toán bên dưới thuộc bản cũ.

Phiên bản mã 3.0.0, ngày 27/09/2026. Hướng dẫn dành cho dự án đã chạy được Phase 2.

## 1. Kết quả của phase này

Luồng mới: **Dự báo ESP32 → đề xuất FastAPI → Ethers bridge → hợp đồng phiên mua/bán → chuyển token SLC → biên lai và đối chiếu dữ liệu nguồn**.

- `SolarToken`: ERC-20, ký hiệu SLC, 6 chữ số thập phân, tổng cung cố định 1.000.000 SLC.
- `EnergyMarket`: mở phiên chào giá, nhận lệnh mua/bán, giữ token của bên mua, khớp lệnh và hoàn tiền dư sau hạn nhận lệnh.
- Mỗi nhà được cấp 1.000 SLC khi triển khai. Đây là token thử nghiệm trên máy tính.
- Nhà 1 dùng đề xuất từ mô hình trên ESP32. Nhà 2/3 trong demo dùng **lệnh đối ứng được script tạo**, gắn `demo_counterparty`; không có mô hình AI riêng.
- Dữ liệu nguồn được băm và lưu trong lệnh. Biên lai có mã giao dịch, số block, trạng thái thành công và lượng token thanh toán.
- Backend vẫn lưu toàn bộ số đo/dự báo như Phase 2; bổ sung API đọc kết quả blockchain và cột blockchain trong bảng đề xuất.

Phase này dùng blockchain local, không cần ví thật, faucet, MetaMask hoặc tiền thật. Nó mô phỏng giao dịch và thanh toán; chưa xác minh giao điện vật lý. Giao diện MetaMask/testnet là bước tiếp theo.

## 2. Cài gói bổ sung vào dự án hiện tại

Dự án của bạn:

```text
C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1
```

1. Đợi simulator kết thúc nếu đang chạy. Dừng riêng terminal backend bằng **Ctrl+C** để cập nhật mã.
2. Giải nén `p2p-solar-phase3-addon.zip` ra một thư mục tạm.
3. Chép toàn bộ nội dung gói vào thư mục dự án ở trên, đồng ý thay các file trùng tên.
4. Kiểm tra `package.json`, `hardhat.config.ts`, `contracts/`, `blockchain/` nằm **ngay trong thư mục gốc dự án**, không bị lồng thêm một cấp.

Gói bổ sung chứa các file backend cần cập nhật cùng mã blockchain và tài liệu. Nó **không chứa** `mosquitto.conf`, `.vscode`, `.venv`, cấu hình firmware, `sdkconfig` hay dữ liệu của bạn. Database `data/phase2.sqlite3` giữ nguyên, không đổi schema.

Nếu dùng ZIP toàn bộ dự án cho máy mới, vẫn phải tự cấu hình IP/Wi-Fi và ESP-IDF theo Phase 1/2. Với máy đang chạy ổn định, dùng gói bổ sung.

## 3. Cài Node và thư viện — chỉ làm một lần

Cài **Node.js 24.x, Windows x64** từ https://nodejs.org/en/download, rồi mở lại VS Code/terminal. Bộ mã đã kiểm thử bằng Node 24.19.0; Hardhat 3 hỗ trợ Node từ 22.13.0 và các dòng major chẵn được hỗ trợ.

Mở PowerShell thường, không cần Administrator hoặc ESP-IDF Terminal:

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
node --version
npm.cmd --version
npm.cmd ci
npm.cmd run compile
npm.cmd test
```

`npm.cmd` giúp tránh lỗi PowerShell chặn `npm.ps1`. Lần cài thư viện cần Internet. Biên dịch dùng bản `solc` đã ghim trong package-lock, không tải compiler riêng từ server Solidity. Sau khi cài đủ phụ thuộc, demo local không cần Internet, nhưng ESP32 vẫn cần mạng LAN tới broker.

Kỳ vọng: hai hợp đồng biên dịch thành công và **17 kiểm thử Node đạt**. `npm test` tự mở node thử ở cổng tạm, không xóa dữ liệu node demo 8545.

Không thay phiên bản package hoặc chạy `npm audit fix --force` giữa quá trình demo; `package-lock.json` ghi đúng bộ đã kiểm thử.

## 4. Chạy lần đầu bằng dữ liệu Phase 2 đã lưu

Đây là cách nhanh nhất để kiểm tra phần blockchain trên dữ liệu 277 dự báo bạn đã có. **Không cần chạy lại lượt simulator 24 phút.** Lịch sử được ghi rõ là `replay`, không phải giao dịch trực tiếp tại thời điểm đã mô phỏng.

Mỗi terminal dưới đây đều mở tại thư mục gốc dự án.

### Terminal A — Mosquitto

Nếu broker vẫn đang chạy thì giữ nguyên, không mở thêm bản thứ hai. Nếu đã dừng:

```powershell
& "C:\Program Files\mosquitto\mosquitto.exe" -c ".\mosquitto.conf" -v
```

Để dùng lại ESP32 trong bước live, broker cần lắng nghe 1884 và 1885 như Phase 2. Giữ terminal này chạy.

### Terminal B — backend cập nhật

```powershell
.\.venv-backend\Scripts\python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884
```

Đợi `Uvicorn running on http://127.0.0.1:8000`. Giữ terminal chạy. Backend dùng lại file SQLite hiện tại.

Nếu chỉ muốn kiểm tra lịch sử mà chưa bật broker, có thể dùng `--no-mqtt` thay các tham số MQTT. Chế độ đó chỉ dùng được replay; live cần backend MQTT sẵn sàng.

### Terminal C — blockchain Hardhat

```powershell
npm.cmd run chain
```

Đợi server tại `http://127.0.0.1:8545`. Giữ cửa sổ này chạy. Các tài khoản/private key Hardhat in ra là tài khoản demo công khai; không dùng chúng với tiền thật.

### Terminal D — triển khai và chạy giao dịch

```powershell
npm.cmd run deploy
```

Lệnh này triển khai hai hợp đồng, cấp token demo cho ba nhà và ghi địa chỉ vào `data\phase3\deployment.json`. Chạy lại khi deployment vẫn tồn tại sẽ dùng lại, không cấp thêm token.

Chọn lượt Phase 2 mới nhất có 864/277/277 như bạn vừa kiểm tra:

```powershell
$runId = (Invoke-RestMethod "http://127.0.0.1:8000/api/runs" -ErrorAction Stop).items[0].run_id
"Run ID: $runId"
npm.cmd run demo:backend -- --run-id $runId --count 3
npm.cmd run market:report
```

Demo lấy ba đề xuất mua/bán hợp lệ đầu tiên theo thời gian trong lượt được chọn. Lệnh giữ nguyên (`hold`), dự báo đến trễ hoặc thiếu số đo đầu vào bị bỏ qua. Mỗi đề xuất mở một phiên; nhà 2/3 nhận hai phần lượng đối ứng. Kỳ vọng trên deployment mới:

```text
CONFIRMED round=1 mode=replay orders=3 trades=2 tx=0x...
CONFIRMED round=2 mode=replay orders=3 trades=2 tx=0x...
CONFIRMED round=3 mode=replay orders=3 trades=2 tx=0x...
TOTAL rounds=3 trades=6 pending=0
Market escrow: 0 micro-SLC
```

Trong từng phiên cần thấy `source_hash_ok=true`, `status=1`, và số dư SLC các nhà thay đổi đúng với các giao dịch. **Mã giao dịch và lượng thanh toán cụ thể khác nhau theo dữ liệu của bạn.**

`trades=6` là sáu lần khớp năng lượng. Số giao dịch Ethereum lớn hơn sáu vì còn có triển khai, approve, mở phiên, đặt lệnh và settle.

Chạy lại cùng lệnh `demo:backend` phải hiện `REUSE`; số phiên và số dư không tăng/đổi lần nữa. Replay tăng thời gian block của Hardhat để không phải chờ hạn phiên. Mã chỉ cho phép thao tác này trên Hardhat loopback, chain ID 31337.

## 5. Xem kết quả từ backend

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/api/blockchain/status" | ConvertTo-Json -Depth 8
Invoke-RestMethod "http://127.0.0.1:8000/api/blockchain/rounds" | ConvertTo-Json -Depth 10
Invoke-RestMethod "http://127.0.0.1:8000/api/blockchain/rounds/1" | ConvertTo-Json -Depth 10
```

- `/status`: `configured=true`, `connected=true` khi deployment khớp node đang chạy.
- `/rounds`: danh sách báo cáo đã lưu; không gọi chúng là đã kiểm tra lại chain ngay tại thời điểm đọc danh sách.
- `/rounds/1`: đối chiếu biên lai phiên 1 với chain hiện tại; cần `current_chain_verified=true`.
- `npm run market:report`: đọc hợp đồng, receipt và kiểm tra mã băm file dữ liệu nguồn với on-chain. Thiếu/sai bằng chứng nguồn làm lệnh báo lỗi.

Tại http://127.0.0.1:8000, bảng đề xuất có thêm cột **Blockchain local**. Bảng chỉ hiện 15 đề xuất gần nhất; demo replay lấy ba đề xuất đầu nên chúng có thể không nằm trong 15 dòng đó. Xem `/api/blockchain/rounds` để thấy đầy đủ phiên demo.

API `/api/proposals` vẫn giữ trạng thái tư vấn ban đầu như `observed/stopped`; trường `chain_execution` mô tả việc thực hiện riêng. `on_chain=true` khi receipt được đối chiếu trên chain hiện tại; `null` khi không thể xác minh, `false` khi chưa ghi nhận. Phiên đã settle vẫn có thể có **0 giao dịch khớp**; đọc `trade_count` để phân biệt.

## 6. Demo trực tiếp: simulator → ESP32 → backend → smart contract

Sau khi replay thành công, giữ A/B/C hoạt động. ESP32 dùng firmware đã ổn định ở Phase 2, không cần nạp lại vì phần blockchain.

1. Mở ESP-IDF monitor và đợi `MQTT connected; subscribed solar/home_01/telemetry`.
2. Terminal D: mở cầu nối theo dõi đề xuất mới:

```powershell
npm.cmd run market:live -- --demo-counterparty
```

3. Terminal E: kiểm tra backend và mở simulator **sau khi** bridge đã báo `LIVE: waiting for fresh proposals`:

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/ready"
.\.venv\Scripts\python.exe -m iot_code.simulator --host 127.0.0.1 --port 1884 --config .\config\edge_demo.json --dataset --steps 30 --interval 15
```

Lượt này khoảng **7,5 phút thực**. Giữ `--interval 15` cho demo blockchain: mỗi phiên nhận lệnh 8 giây, cộng thời gian gửi và xác nhận giao dịch. Mỗi khoảng dữ liệu vẫn là 300 giây mô phỏng. Sau khoảng 12 mẫu, ESP32 bắt đầu dự báo và bridge mới có đầu vào.

Bridge kiểm tra `proposed` và `eligible_for_review` ngay trước khi gửi lệnh; bỏ qua dữ liệu hết hạn, hold hoặc dự báo đến trễ. Nó xử lý từng phiên tuần tự, không phải hệ thống xử lý thông lượng cao. Chạy nhanh hơn có thể khiến một số đề xuất hết hạn trước khi gửi; dữ liệu Phase 2 vẫn được lưu.

`--demo-counterparty` cho phép script tự tạo lệnh đối ứng nhà 2/3 trên chain local. Nếu bỏ cờ này, bridge chỉ đặt lệnh của nhà 1; phiên không có đối tác sẽ không khớp và token mua được hoàn lại.

4. Khi simulator `DONE`, đợi phiên đang mở được xác nhận. Nhấn Ctrl+C ở terminal bridge, rồi chạy:

```powershell
npm.cmd run market:settle
npm.cmd run market:report
```

`market:settle` hoàn tất các phiên còn mở sau hạn, kể cả khi trước đó bridge bị dừng. Nếu một phiên bị gián đoạn khi mới có một vài lệnh, không tự chèn thêm lệnh để giả vờ là phiên đã chạy đủ.

Tiêu chí live: có `mode=live`, receipt `status=1`, ít nhất một phiên có `trades>0`, `source_hash_ok=true`, và mã proposal/run trùng lượt ESP32 vừa chạy. Không mặc định mọi dự báo đều phải thành giao dịch: `hold`, không có đối tác, giá không khớp hoặc hết hạn đều có thể không giao dịch.

Để kiểm tra riêng đúng lượt live, lấy Run ID mới sau khi simulator bắt đầu; không dùng lại `$runId` của lượt replay. Nếu muốn cố định bridge vào một lượt đang chạy, thêm `--run-id <ID>`.

## 7. Quy tắc khớp lệnh và tính tiền

| Quy tắc | Cách thực hiện |
|---|---|
| Phiên | Coordinator mở; nhiều nhà gửi giá mua/bán trước hạn |
| Ưu tiên | Mua giá cao trước; bán giá thấp trước; bằng giá thì lệnh đến trước |
| Điều kiện khớp | Giá mua tối đa ≥ giá bán tối thiểu |
| Giá thanh toán | Giá chào bán của lệnh bán được chọn — pay-as-ask |
| Khối lượng | Nhỏ hơn giữa lượng mua còn lại và lượng bán còn lại |
| Ký quỹ | Bên mua gửi `Wh × giá mua tối đa` vào hợp đồng |
| Hoàn tiền | Hoàn lượng không mua được và chênh lệch giữa bid/ask khi settle |
| Hủy | Chính chủ được hủy trước hạn, nhận lại toàn bộ tiền đang giữ |
| Kết thúc | Bất kỳ ví nào cũng có thể gọi settle sau hạn; tối đa một lần |
| Chống lặp | Một nhà/một lệnh/một phiên; sourceId đã dùng không dùng lại ở phiên khác |
| Giới hạn | Tối đa 32 lệnh/phiên, lượng và giá có trần để giữ vòng lặp/tính toán hữu hạn |

Token có 6 số lẻ. Lượng on-chain là **Wh nguyên**, quy đổi từ kWh bằng cách làm tròn xuống, tránh bán quá đề xuất. Ví dụ `0,133333 kWh → 133 Wh`; phần dưới 1 Wh không giao dịch.

Giá `2000 micro-SLC/Wh` tương đương `2 SLC/kWh`. Mua 100 Wh theo giá đó trả `200000 micro-SLC = 0,2 SLC`. Giá demo do script đặt, không phải giá thị trường điện hoặc đầu ra của AI.

Nhà 1 bán: ask 2 SLC/kWh; nhà 2/3 đặt bid 3 và 2,5. Nhà 1 mua: bid 3; nhà 2/3 đặt ask 2 và 2,5. Hai đối tác chia đôi khối lượng (Wh lẻ giao cho đối tác thứ hai).

## 8. File và API quan trọng

| File/đường dẫn | Vai trò |
|---|---|
| `contracts/SolarToken.sol` | ERC-20 demo |
| `contracts/EnergyMarket.sol` | Phiên chào giá, ký quỹ, khớp, hoàn tiền |
| `blockchain/bridge.mjs` | Đọc API Phase 2 và gửi lệnh bằng Ethers |
| `blockchain/lib/backend.mjs` | Kiểm tra liên kết proposal/dự báo/số đo, quy đổi Wh, băm |
| `blockchain/lib/market.mjs` | Mở/khớp phiên, xác minh và ghi báo cáo |
| `backend/chain.py` | API chỉ đọc, đối chiếu receipt với node local |
| `data/phase3/deployment.json` | Địa chỉ deployment đang hoạt động |
| `data/phase3/deployments/` | Lịch sử cấu hình deployment |
| `data/phase3/sources/<deployment_id>/` | JSON nguồn tương ứng dataHash |
| `data/phase3/reports/<deployment_id>/` | Phiên, lệnh, trade, receipt, số dư tại lần đọc báo cáo |
| `data/phase2.sqlite3` | Database Phase 2, không xóa hoặc ghi đè |

Các thư mục sinh ra `node_modules`, `blockchain/artifacts`, `data/phase3` được bỏ qua khi commit Git. Giữ bản sao biên lai cần dùng cho báo cáo trước khi dọn dữ liệu. Không sửa trực tiếp file bằng chứng nguồn; sửa sẽ làm kiểm tra hash thất bại.

## 9. Các lỗi thường gặp

| Lỗi | Cách xử lý |
|---|---|
| `npm`/`node` không nhận diện | Cài Node 24.x, đóng/mở lại VS Code và kiểm tra PATH |
| `npm.ps1 cannot be loaded` | Dùng `npm.cmd` như các lệnh ở trên |
| `ECONNREFUSED ...8545` | Giữ terminal `npm.cmd run chain` hoạt động |
| Backend `Unable to connect ...8000` | Khởi động terminal backend riêng |
| `No run found` | Backend đang đọc DB trống/sai đường dẫn; kiểm tra `/health` và `/api/runs` |
| `No linked non-hold...` | Chọn lượt có dự báo hợp lệ và hành động buy/sell; không đổi hold thành lệnh giả |
| `LIVE WAIT: ...503` | Broker/backend chưa sẵn sàng; kiểm tra `/ready`, cổng 1884 và ESP32 |
| `LIVE WAIT: ...expired` | Nhịp gửi quá nhanh hoặc mạng trễ; dùng interval 15, kiểm tra log; chạy market:settle sau khi dừng bridge |
| `Closed` khi đặt lệnh | Đã hết hạn nhận lệnh; settle/refund rồi dùng đề xuất mới |
| `Another Phase 3 writer is running` | Đang có bridge/deploy/settle khác; dừng lệnh đó trước |
| `source ... hash ... mismatch` | File bằng chứng bị thiếu/thay đổi; dùng bản gốc, không sửa hash để ép pass |
| Backend `/api/blockchain/...` trả 404 | Chưa chép bản cập nhật hoặc chưa khởi động lại backend |
| `Deployment ... changed` | Node Hardhat bị khởi động lại; chạy deploy để tạo deployment mới rồi demo lại |

**Hardhat local không tự giữ chain khi tắt node.** SQLite Phase 2 và báo cáo JSON vẫn còn, nhưng chain đã khởi động lại không chứa các giao dịch cũ. Mỗi deployment có ID riêng để tránh nhầm biên lai cũ là của chain hiện tại. Không xóa SQLite để sửa lỗi này.

Nếu Ctrl+C đúng lúc đang gửi lệnh, giao dịch có thể đã được ghi vào chain. Chạy `market:settle` và `market:report` để kiểm tra; không tự đặt lại với ID khác. Writer lock có PID, tự thu hồi khi tiến trình cũ đã chết.

## 10. Kiểm thử và bằng chứng báo cáo

Kiểm thử hợp đồng/bridge:

```powershell
npm.cmd test
```

Kiểm thử tích hợp tự động, dùng DB/Hardhat tạm tách biệt dữ liệu demo:

```powershell
npm.cmd run test:integration
```

Mặc định tìm Python trong `.venv-backend`. Nếu cần chỉ định:

```powershell
npm.cmd run test:integration -- --python ".\.venv-backend\Scripts\python.exe"
```

Integration dùng **dự báo fixture tổng hợp**, không chạy AI trên ESP32. Nó kiểm tra API FastAPI thật, SQLite thật, Ethers và EVM Hardhat thật. Bài live trong integration giả lập trạng thái MQTT sẵn sàng bên trong fixture. Xem `PHASE3_VALIDATION.md` để phân biệt với bằng chứng chạy board của bạn.

Để chốt Phase 3 trên máy của nhóm, lưu: Run ID Phase 2; địa chỉ token/market; output `market:report`; receipt có `status=1`; ít nhất một phiên live; ảnh log ESP32 cùng lượt; bằng chứng chạy lại không trừ tiền lần nữa. Ghi rõ dữ liệu điện vẫn là mô phỏng, AI thực thi trên board, token và blockchain là local.

## 11. Giới hạn thiết kế để trình bày đúng

- Coordinator và bridge local được tin cậy, dùng ba ví Hardhat mở khóa. Chưa có chữ ký từ người dùng/MetaMask hoặc oracle xác minh ESP32.
- Hash bảo vệ khả năng phát hiện thay đổi dữ liệu đã cam kết, **không tự chứng minh cảm biến hoặc AI nói thật**.
- Seller cam kết lượng năng lượng nhưng không ký quỹ điện vật lý; hệ thống không điều khiển lưới điện hay xác minh giao hàng.
- Thanh toán SLC xảy ra khi khớp lệnh mô phỏng, chưa xử lý sai lệch dự báo bằng thanh toán bù trừ.
- Contract dùng `SafeERC20` và `ReentrancyGuard`, có kiểm thử, nhưng đây không phải kết quả kiểm toán bảo mật để triển khai tiền thật.
- Không tuyên bố hoàn tất mọi yêu cầu đồ án: còn báo cáo 10–15 trang, thuyết trình; dashboard MetaMask/testnet có thể bổ sung ở Phase 4.

## Tài liệu tham chiếu

- Yêu cầu đồ án: `final_project_requirements.pdf`, mục 2.1, 3.1, 5 (Solidity, local Hardhat được chấp nhận, kết nối Ethers/Web3, thư mục `/contracts`).
- Hardhat Node support: https://hardhat.org/docs/reference/nodejs-support
- Local node: https://hardhat.org/docs/guides/hardhat-node
- OpenZeppelin ERC20/SafeERC20: https://docs.openzeppelin.com/contracts/5.x/api/token/erc20
- OpenZeppelin ReentrancyGuard: https://docs.openzeppelin.com/contracts/5.x/api/utils
