# Community Shop Admin

社區團購平台的管理後台專用版本，使用 HTML、CSS、Vanilla JavaScript 與 Firebase Firestore。

這個 repository 只保留管理端需要的頁面與共用資源，不包含前台購物頁、商品詳情頁、訂單查詢頁或許願池頁。

## Included Pages

- `admin-login.html`：管理員登入
- `admin.html`：Dashboard
- `admin-products.html`：商品管理
- `admin-orders.html`：訂單管理
- `admin-pickup.html`：取貨管理
- `admin-announcements.html`：公告管理
- `admin-wishes.html`：許願管理
- `order-detail.html`：後台訂單詳細頁，供 `admin-orders.html` 使用 `?admin=1` 開啟

## Shared Assets

- `css/styles.css`
- `js/app.js`
- `js/firebase.js`
- `js/firebase-config.js`
- `firestore.rules`

## Firebase Setup

1. 建立 Firebase 專案。
2. 啟用 Authentication 的 Email/Password 登入。
3. 建立管理員 Email 使用者。
4. 啟用 Firestore Database。
5. 將 Firebase Web App config 放在 `js/firebase-config.js`。
6. 部署後從 `admin-login.html` 進入後台。

## Firestore Collections

後台沿用既有資料結構，不修改 collection 名稱：

- `products`
- `orders`
- `publicOrders`
- `productImages`
- `productCategories`
- `announcements`
- `wishes`

## Notes

- 這個 repo 是 admin-only 發布版本。
- 前台頁面已從此 repo 移除，避免部署後暴露購物前台入口。
- `js/app.js` 仍保留部分共用 helper，方便後台訂單、商品、許願與公告功能沿用既有流程。
