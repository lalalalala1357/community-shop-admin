# 社區團購平台 v1.3

手機優先的純前端社區團購 MVP，使用 HTML/CSS/Vanilla JavaScript 與 Firebase。

## 功能

- 前台商品展示、商品詳情、預購下單、訂單查詢、專屬查詢網址
- 管理端 Email 登入、儀表板、商品管理、直接上傳圖片或填圖片網址、上下架
- 訂單搜尋、狀態更新、CSV 匯出
- 取貨快速搜尋與確認取貨
- Firestore transaction 防止超賣，超過截單時間禁止下單
- 手機號碼查詢全部訂單，並分類為全部、進行中訂單與歷史訂單
- 取貨管理提供今日可取貨清單
- 訂單管理提供採購清單統計
- 管理端可編輯訂單資料並同步商品已售數量
- 客人可提出取消訂單申請，管理端可同意或拒絕
- 商品支援分類，首頁可依分類篩選
- 首頁公告欄與管理端公告管理
- 預留客戶與商品統計函式，不建立分析頁面 UI

## Firebase 設定

1. 建立 Firebase 專案。
2. 啟用 Authentication 的 Email/Password 登入。
3. 建立管理員 Email 使用者。
4. 啟用 Firestore Database。
5. 商品圖片可直接在瀏覽器壓縮後存入 Firestore；也可填公開圖片網址。
6. 將 Firebase Web App config 貼到 `js/firebase-config.js`。
7. 部署到 GitHub Pages。

## Firestore Collections

`products`

- id
- name
- price
- spec
- description
- category
- imageUrl
- deadline
- pickupTime
- pickupLocation
- stockLimit
- soldCount
- isActive
- createdAt
- updatedAt

`orders`

- orderId
- customerId
- productId
- productName
- price
- quantity
- totalAmount
- customerName
- phone
- lineId
- note
- adminNote
- status
- cancelRequested
- cancelReason
- cancelRequestedAt
- cancelApproved
- cancelRejected
- cancelRejectReason
- pickupTime
- pickupLocation
- createdAt
- updatedAt

`customerId` 規則：

- 新訂單會寫入 `customerId = phone`
- 舊訂單若沒有 `customerId`，前台查詢仍會用 `phone` 相容查詢

`announcements`

- title
- content
- type
- isActive
- pinned
- createdAt
- updatedAt

公告類型：

- 一般公告
- 到貨公告
- 取貨提醒
- 臨時通知

舊資料相容：

- 舊 orders 沒有 `adminNote`：顯示空白
- 舊 orders 沒有 `cancelRequested`：視為 false
- 舊 products 沒有 `category`：顯示為「其他」
- 舊 announcements collection 不存在：首頁顯示目前沒有公告

## v1.3 修改檔案

- `js/app.js`
- `index.html`
- `admin.html`
- `order-search.html`
- `admin-orders.html`
- `admin-pickup.html`
- `admin-products.html`
- `admin-announcements.html`
- `css/styles.css`
- `README.md`

## v1.3 訂單修改

管理端 `admin-orders.html` 可編輯：

- customerName
- phone
- lineId
- quantity
- note
- adminNote
- status

修改 `quantity` 時會使用 Firestore transaction：

- 增加數量：確認 `soldCount + 增加數量 <= stockLimit`
- 減少數量：同步扣回 `soldCount`
- `totalAmount = price * quantity`
- 更新 `updatedAt`

若管理端將訂單改成 `已取消`，商品 `soldCount` 會同步扣回。若從 `已取消` 改回進行中，會重新檢查庫存。

## v1.3 取消申請

客人可在 `order-detail.html` 對 `已下單` 訂單申請取消。

送出後更新：

- cancelRequested = true
- cancelReason
- cancelRequestedAt

管理端可：

- 同意取消：`status = 已取消`、`cancelApproved = true`，並扣回商品 `soldCount`
- 拒絕取消：`cancelRequested = false`、`cancelRejected = true`、`cancelRejectReason`

客人訂單詳細頁會顯示：

- 取消申請審核中
- 取消已同意
- 取消被拒絕與原因

## v1.3 商品分類與公告

商品分類：

- 商品管理可填寫 `category`
- 首頁商品卡會顯示分類
- 首頁可依分類篩選

公告欄：

- 首頁 Hero 下方顯示公告欄
- 只顯示 `isActive = true`
- `pinned = true` 排最上方
- 最多顯示 5 則

公告管理：

- `admin-announcements.html`
- 新增公告
- 編輯公告
- 刪除公告
- 上架 / 下架公告
- 設定置頂

## v1.2 訂單分類

訂單狀態簡化為：

- 已下單
- 可取貨
- 已取貨
- 已取消
- 未取貨：取貨日期結束後由系統自動判斷

進行中訂單：

- 已下單
- 可取貨

歷史訂單：

- 已取貨
- 已取消
- 未取貨

管理端分類：

- 全部訂單
- 進行中訂單
- 已完成訂單：`status = 已取貨`
- 已取消訂單：`status = 已取消`

管理端可手動修改：

- 已下單
- 可取貨
- 已取貨
- 已取消

`未取貨` 不提供手動修改。當取貨時間那一天結束後，系統會在顯示時自動歸為 `未取貨`；管理端載入訂單時也會嘗試寫回 Firestore。

舊資料相容：

- 舊的 `採購中` 會顯示為 `已下單`
- 舊的 `商品已到貨` 會顯示為 `可取貨`
- 舊的 `已取消`、`未取貨` 會保留原狀並歸入歷史訂單

## v1.2 取貨與採購

查詢頁分頁：

- 全部
- 進行中
- 歷史訂單

取貨管理：

- 自動顯示今日可取貨清單
- 快速搜尋不顯示 `已取貨`、`已取消`、`未取貨`

採購清單：

- 訂單管理可按 `產生採購清單`
- 依目前篩選後的進行中訂單彙總商品數量
- 歷史訂單不列入採購清單

## 預留統計函式

`js/app.js` 已新增：

- `calculateCustomerStats(orders, customerId)`：訂單總數、總消費金額、最近下單時間
- `calculateProductStats(orders, productId)`：商品銷售數量、商品銷售金額

目前不提供分析頁面 UI。

## 資料遷移

v1.1 不需要強制遷移，舊訂單沒有 `customerId` 仍可透過 `phone` 查詢。

若未來要補齊舊訂單的 `customerId`，可在管理員登入後於瀏覽器 console 執行一次性腳本。執行前請先備份 Firestore。

```js
const { db } = await import("./js/firebase.js");
const {
  collection,
  getDocs,
  doc,
  updateDoc
} = await import("./js/firebase.js");

const snap = await getDocs(collection(db, "orders"));
for (const item of snap.docs) {
  const order = item.data();
  if (!order.customerId && order.phone) {
    await updateDoc(doc(db, "orders", item.id), {
      customerId: order.phone
    });
  }
}
```

## 建議 Firestore Rules

安全提醒：

- 目前程式沒有在一般前台直接撈全部訂單；全部訂單列表只在管理端登入後使用。
- 純前端匿名「手機號碼查詢全部訂單」無法用 Firestore Rules 做到完全安全，因為沒有後端可驗證查詢者是否真的持有該手機號碼。
- 專案已提供 `firestore.rules`，適合這幾天放 GitHub 做公開測試：匿名客人可用訂單編號讀單筆訂單，但不能公開列出全部訂單。
- 若套用 `firestore.rules`，手機號碼查全部訂單會被 Firestore 擋下；之後要保留這個功能並兼顧安全，需要改由 Cloud Functions、登入驗證、簡訊 OTP 或其他後端驗證處理。

較安全的上線方向請使用專案根目錄的 `firestore.rules`。

若仍維持純前端 MVP 並保留匿名手機查詢全部訂單，`orders` 需要開放對應查詢讀取；這會有客戶電話資料外洩風險，不建議作為正式上線規則。

### GitHub 公開測試建議

1. 到 Firebase Console。
2. 進入 Firestore Database。
3. 打開 Rules。
4. 貼上專案根目錄的 `firestore.rules` 內容。
5. 按 Publish。

套用後：

- 商品、公告、許願池：公開可讀。
- 客人下單：可用。
- 訂單編號查詢：可用。
- 手機查全部訂單：會被擋，這是為了避免電話資料外洩。
- 管理端：登入後可看全部訂單、改狀態、管理商品與公告。

## 建議 Storage Rules

目前 MVP 不必啟用 Storage；商品圖片會壓縮後存進 Firestore。若未來商品變多、圖片較大，再改用 Firebase Storage。

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /products/{fileName} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```
