import {
  auth,
  db,
  storage,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  ref,
  uploadBytes,
  getDownloadURL
} from "./firebase.js";

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const money = value => `NT$ ${Number(value || 0).toLocaleString("zh-TW")}`;
const dateText = value => value ? new Date(value).toLocaleString("zh-TW", { hour12: false }) : "-";
const todayKey = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");

const statusMap = {
  "已下單": "blue",
  "可取貨": "green",
  "已取貨": "gray",
  "已取消": "red",
  "未取貨": "orange"
};

const statusOptions = ["已下單", "可取貨", "已取貨"];
const activeOrderStatuses = ["已下單", "可取貨"];
const historyOrderStatuses = ["已取貨", "已取消", "未取貨"];
const announcementTypes = ["一般公告", "到貨公告", "取貨提醒", "臨時通知"];

function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function statusBadge(status) {
  const normalizedStatus = normalizeOrderStatus(status);
  return `<span class="status status-${statusMap[normalizedStatus] || "blue"}">${normalizedStatus}</span>`;
}

function placeholderImage(name = "社區團購") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" fill="#dbeafe"/><circle cx="450" cy="120" r="120" fill="#bfdbfe"/><rect x="110" y="150" width="380" height="300" rx="32" fill="#fff"/><text x="300" y="315" text-anchor="middle" font-family="Arial" font-size="42" font-weight="700" fill="#2563eb">${name.slice(0, 8)}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function normalizeProduct(id, data) {
  return { id, soldCount: 0, stockLimit: 0, stockUnlimited: false, isActive: true, category: "其他", saleStart: "", saleEnd: "", ...data };
}

function normalizeOrder(data) {
  return {
    totalAmount: Number(data.price || 0) * Number(data.quantity || 0),
    customerId: data.customerId || data.phone || "",
    productCategory: data.productCategory || "其他",
    adminNote: "",
    cancelRequested: false,
    cancelApproved: false,
    cancelRejected: false,
    cancelReason: "",
    cancelRejectReason: "",
    ...data,
    status: normalizeOrderStatus(data.status, data.pickupTime)
  };
}

function normalizeAnnouncement(id, data) {
  return {
    id,
    title: "",
    content: "",
    type: "一般公告",
    isActive: true,
    pinned: false,
    ...data
  };
}

function normalizeWish(id, data) {
  return {
    id,
    title: "",
    description: "",
    imageUrl: "",
    customerName: "",
    phone: "",
    votes: 0,
    voters: [],
    isActive: true,
    ...data
  };
}

function normalizeOrderStatus(status, pickupTime) {
  if (status === "已取貨" || status === "已取消" || status === "未取貨") return status;
  if (isPastPickupDate(pickupTime)) return "未取貨";
  if (status === "可取貨" || status === "商品已到貨") return "可取貨";
  return "已下單";
}

function isPastPickupDate(pickupTime) {
  if (!pickupTime) return false;
  const pickupDate = new Date(pickupTime);
  if (Number.isNaN(pickupDate.getTime())) return false;
  const endOfPickupDate = new Date(pickupDate);
  endOfPickupDate.setHours(23, 59, 59, 999);
  return new Date() > endOfPickupDate;
}

async function activeProducts() {
  const snap = await getDocs(query(collection(db, "products"), where("isActive", "==", true)));
  return snap.docs
    .map(item => normalizeProduct(item.id, item.data()))
    .filter(isProductOnSale)
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
}

function isProductUnlimited(product) {
  return product.stockUnlimited === true || Number(product.stockLimit || 0) <= 0;
}

function productRemainingText(product) {
  if (isProductUnlimited(product)) return "不限量";
  return `剩餘 ${Math.max(Number(product.stockLimit || 0) - Number(product.soldCount || 0), 0)}`;
}

function salePeriodText(product) {
  if (!product.saleStart && !product.saleEnd) return "";
  const start = product.saleStart ? dateText(product.saleStart) : "現在";
  const end = product.saleEnd ? dateText(product.saleEnd) : "售完為止";
  return `${start} - ${end}`;
}

function isProductOnSale(product) {
  const now = new Date();
  if (product.saleStart && new Date(product.saleStart) > now) return false;
  if (product.saleEnd && new Date(product.saleEnd) < now) return false;
  return true;
}

async function activeAnnouncements() {
  const snap = await getDocs(query(collection(db, "announcements"), where("isActive", "==", true)));
  return snap.docs
    .map(item => normalizeAnnouncement(item.id, item.data()))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return createdAtMillis(b) - createdAtMillis(a);
    })
    .slice(0, 5);
}

function announcementCard(announcement) {
  return `
    <span>${announcement.pinned ? "置頂" : announcement.type || "公告"}：${announcement.title} ${announcement.content}</span>
  `;
}

function productCard(product) {
  return `
    <article class="card product-card">
      <img src="${product.imageUrl || placeholderImage(product.name)}" alt="${product.name}">
      <div class="product-card-body">
        <h3>${product.name}</h3>
        <div class="price">${money(product.price)}</div>
        <p class="meta">${product.category || "其他"}</p>
        <p class="meta">${product.spec || "無規格"} · ${productRemainingText(product)}</p>
        <p class="meta">截單 ${dateText(product.deadline)}</p>
        <a class="btn" href="product.html?id=${product.id}">我想預訂</a>
      </div>
    </article>
  `;
}

async function initHome() {
  const [announcements, products] = await Promise.all([activeAnnouncements(), activeProducts()]);
  const announcementList = $("#announcementList");
  announcementList.innerHTML = announcements.length ? announcements.map(announcementCard).join("") : `<span>目前沒有新的公告</span>`;
  const featuredProductList = $("#featuredProductList");
  featuredProductList.innerHTML = [...products].sort(sortByCreatedDesc).slice(0, 5).map(productCard).join("") || `<div class="empty card">目前沒有上架商品</div>`;
}

async function initPublicProducts() {
  const products = await activeProducts();
  const productList = $("#productList");
  const categoryFilter = $("#categoryFilter");
  let selectedCategory = "全部";
  const renderProducts = () => {
    const filteredProducts = selectedCategory === "全部" ? products : products.filter(product => (product.category || "其他") === selectedCategory);
    productList.innerHTML = filteredProducts.length ? filteredProducts.map(productCard).join("") : `<div class="empty card">這個分類目前還沒有商品</div>`;
  };

  const categories = ["全部", ...new Set(products.map(product => product.category || "其他"))];
  categoryFilter.innerHTML = categories.map(category => `<button class="chip ${category === selectedCategory ? "active" : ""}" type="button" data-category="${category}">${category}</button>`).join("");
  $$(".chip", categoryFilter).forEach(button => button.addEventListener("click", () => {
    selectedCategory = button.dataset.category;
    $$(".chip", categoryFilter).forEach(item => item.classList.toggle("active", item.dataset.category === selectedCategory));
    renderProducts();
  }));
  renderProducts();
}

async function nextOrderId() {
  const prefix = `O${todayKey()}`;
  const snap = await getDocs(query(collection(db, "orders"), where("orderId", ">=", prefix), where("orderId", "<", `${prefix}Z`), orderBy("orderId", "desc"), limit(1)));
  const last = snap.docs[0]?.data().orderId;
  const seq = last ? Number(last.slice(-4)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

async function initProductDetail() {
  const id = getParam("id");
  const root = $("#productDetail");
  if (!id) {
    root.innerHTML = `<div class="notice">缺少商品 ID</div>`;
    return;
  }

  const productRef = doc(db, "products", id);
  const productSnap = await getDoc(productRef);
  if (!productSnap.exists()) {
    root.innerHTML = `<div class="notice">找不到商品</div>`;
    return;
  }

  const product = normalizeProduct(productSnap.id, productSnap.data());
  const remaining = Math.max(Number(product.stockLimit || 0) - Number(product.soldCount || 0), 0);
  const canOrder = isProductOnSale(product) && (isProductUnlimited(product) || remaining > 0);
  root.innerHTML = `
    <div class="card">
      <img class="product-image" src="${product.imageUrl || placeholderImage(product.name)}" alt="${product.name}">
    </div>
    <div class="card card-body">
      <p class="eyebrow">商品詳情</p>
      <div class="product-title-row">
        <h1>${product.name}</h1>
        ${salePeriodText(product) ? `<span class="meta">${salePeriodText(product)}</span>` : ""}
      </div>
      <div class="price">${money(product.price)}</div>
      <p>${product.description || ""}</p>
      <div class="info-list">
        <div class="info-row"><span>規格</span><strong>${product.spec || "-"}</strong></div>
        <div class="info-row"><span>分類</span><strong>${product.category || "其他"}</strong></div>
        <div class="info-row"><span>剩餘數量</span><strong>${productRemainingText(product)}</strong></div>
        <div class="info-row"><span>截單時間</span><strong>${dateText(product.deadline)}</strong></div>
        <div class="info-row"><span>取貨時間</span><strong>${dateText(product.pickupTime)}</strong></div>
        <div class="info-row"><span>取貨地點</span><strong>${product.pickupLocation || "-"}</strong></div>
      </div>
      <button class="btn" id="openOrderModalBtn" ${canOrder ? "" : "disabled"}>立即預購</button>
      <div class="modal" id="orderModal">
        <div class="card modal-panel">
          <button class="modal-close" id="closeOrderModal" type="button" aria-label="關閉">×</button>
          <h2>立即預購</h2>
          <form class="form" id="orderForm">
        <div class="field"><label>姓名</label><input name="customerName" required autocomplete="name"></div>
        <div class="field"><label>電話</label><input name="phone" required inputmode="tel" autocomplete="tel"></div>
        <div class="field"><label>LINE ID（選填）</label><input name="lineId"></div>
        <div class="field"><label>數量</label><input name="quantity" type="number" min="1" ${isProductUnlimited(product) ? "" : `max="${remaining}"`} value="1" required></div>
        <div class="field"><label>備註</label><textarea name="note"></textarea></div>
            <button class="btn">送出預購</button>
          </form>
        </div>
      </div>
    </div>
  `;

  $("#openOrderModalBtn")?.addEventListener("click", () => $("#orderModal").classList.add("open"));
  $("#closeOrderModal")?.addEventListener("click", () => $("#orderModal").classList.remove("open"));
  $("#orderForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const quantity = Number(form.get("quantity"));
    const orderId = await nextOrderId();

    try {
      await runTransaction(db, async transaction => {
        const freshSnap = await transaction.get(productRef);
        const fresh = normalizeProduct(productRef.id, freshSnap.data());
        if (!fresh?.isActive) throw new Error("商品目前未上架");
        if (!isProductOnSale(fresh)) throw new Error("商品目前不在販售期間");
        if (new Date(fresh.deadline) < new Date()) throw new Error("已超過截單時間");
        if (!isProductUnlimited(fresh) && Number(fresh.soldCount || 0) + quantity > Number(fresh.stockLimit || 0)) throw new Error("剩餘數量不足");

        const orderRef = doc(db, "orders", orderId);
        transaction.set(orderRef, {
          orderId,
          productId: id,
          productName: fresh.name,
          productCategory: fresh.category || "其他",
          price: Number(fresh.price || 0),
          quantity,
          totalAmount: Number(fresh.price || 0) * quantity,
          customerName: form.get("customerName").trim(),
          phone: form.get("phone").trim(),
          customerId: form.get("phone").trim(),
          lineId: form.get("lineId").trim(),
          note: form.get("note").trim(),
          status: "已下單",
          pickupTime: fresh.pickupTime,
          pickupLocation: fresh.pickupLocation,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        transaction.update(productRef, { soldCount: Number(fresh.soldCount || 0) + quantity, updatedAt: serverTimestamp() });
      });
      location.href = `order-success.html?id=${orderId}`;
    } catch (error) {
      alert(error.message);
    }
  });
}

async function findOrderById(orderId) {
  if (!orderId) return null;
  const snap = await getDoc(doc(db, "orders", orderId));
  return snap.exists() ? normalizeOrder(snap.data()) : null;
}

function orderSummary(order, options = {}) {
  const isAdmin = options.admin === true;
  const detailUrl = `${location.origin}${location.pathname.replace(/[^/]+$/, "")}order-detail.html?id=${order.orderId}`;
  return `
    <div class="card card-body">
      ${isAdmin ? `
        <div class="detail-title-row">
          <div class="detail-title-main">
            <h2>${order.orderId}</h2>
            <button class="btn secondary inline" id="editOrderDetailBtn" type="button">修改訂單</button>
          </div>
          ${statusBadge(order.status)}
        </div>
      ` : `<h2>${order.orderId}</h2>`}
      <div class="info-list">
        <div class="info-row"><span>商品名稱</span><strong>${order.productName}</strong></div>
        <div class="info-row"><span>數量</span><strong>${order.quantity}</strong></div>
        <div class="info-row"><span>總金額</span><strong>${money(order.totalAmount)}</strong></div>
        ${isAdmin ? "" : `<div class="info-row"><span>狀態</span><strong>${statusBadge(order.status)}</strong></div>`}
        <div class="info-row"><span>取貨時間</span><strong>${dateText(order.pickupTime)}</strong></div>
        <div class="info-row"><span>取貨地點</span><strong>${order.pickupLocation || "-"}</strong></div>
        <div class="info-row"><span>下單時間</span><strong>${orderDateText(order)}</strong></div>
        <div class="info-row"><span>客人備註</span><strong>${order.note || "-"}</strong></div>
        ${isAdmin ? `<div class="info-row"><span>管理員備註</span><strong>${order.adminNote || "-"}</strong></div>` : ""}
      </div>
      ${cancelRequestInfo(order)}
      <p class="notice">專屬查詢網址：<br><a href="${detailUrl}">${detailUrl}</a></p>
      ${isAdmin ? adminCancelButton(order) : cancelRequestButton(order)}
    </div>
  `;
}

function cancelRequestInfo(order) {
  if (order.cancelApproved) return `<p class="notice">取消已同意，此訂單已取消。</p>`;
  if (order.cancelRejected) return `<p class="notice">取消申請已被拒絕：${order.cancelRejectReason || "未填寫原因"}</p>`;
  if (order.cancelRequested) return `<p class="notice">取消申請審核中：${order.cancelReason || "未填寫原因"}</p>`;
  return "";
}

function cancelRequestButton(order) {
  if (document.body.dataset.page !== "detail") return "";
  if (getParam("admin") === "1") return "";
  if (order.status !== "已下單" || order.cancelRequested || order.cancelApproved || order.cancelRejected) return "";
  return `<button class="btn danger" id="cancelRequestBtn" data-id="${order.orderId}">申請取消訂單</button>`;
}

function adminCancelButton(order) {
  if (order.status === "已取消") return "";
  return `<button class="btn danger" id="adminCancelOrderBtn" data-id="${order.orderId}">取消訂單</button>`;
}

async function initOrderSuccess() {
  const order = await findOrderById(getParam("id"));
  $("#orderSuccess").innerHTML = order ? orderSummary(order) : `<div class="notice">找不到訂單</div>`;
}

async function initOrderDetail() {
  if (getParam("admin") === "1") {
    document.body.dataset.adminDetail = "true";
    requireAdmin(async () => {
      const order = await findOrderById(getParam("id"));
      $("#orderDetail").innerHTML = order ? orderSummary(order, { admin: true }) : `<div class="notice">找不到訂單</div>`;
      $("#adminCancelOrderBtn")?.addEventListener("click", async () => {
        if (!order || !confirm("確認直接取消此訂單？商品已售數量會同步扣回。")) return;
        await cancelOrderWithStock(order, { cancelRequested: false });
        alert("訂單已取消。");
        location.reload();
      });
      $("#editOrderDetailBtn")?.addEventListener("click", () => openOrderEditModal(order));
    });
    return;
  }

  const order = await findOrderById(getParam("id"));
  $("#orderDetail").innerHTML = order ? orderSummary(order) : `<div class="notice">找不到訂單</div>`;
  $("#cancelRequestBtn")?.addEventListener("click", async event => {
    const confirmed = confirm("確定要申請取消此訂單嗎？送出後需等待管理員確認。");
    if (!confirmed) return;
    const cancelReason = prompt("請輸入取消原因") || "";
    await updateDoc(doc(db, "orders", event.currentTarget.dataset.id), {
      cancelRequested: true,
      cancelReason: cancelReason.trim(),
      cancelRequestedAt: serverTimestamp(),
      cancelRejected: false,
      cancelRejectReason: "",
      updatedAt: serverTimestamp()
    });
    alert("已送出取消申請，請等待管理員確認。");
    location.reload();
  });
}

async function initOrderSearch() {
  const form = $("#searchForm");
  const results = $("#searchResults");
  let currentOrders = [];
  let currentTab = "all";

  const render = () => {
    if (!currentOrders.length) {
      results.innerHTML = `<div class="empty card">查無訂單</div>`;
      return;
    }

    const activeOrders = currentOrders.filter(order => activeOrderStatuses.includes(order.status));
    const historyOrders = currentOrders.filter(order => historyOrderStatuses.includes(order.status));
    const tabMap = {
      all: currentOrders,
      active: activeOrders,
      history: historyOrders
    };
    const titleMap = {
      all: "全部訂單",
      active: "進行中訂單",
      history: "歷史訂單"
    };
    const list = tabMap[currentTab] || currentOrders;

    $$(".orderTab").forEach(button => button.classList.toggle("active", button.dataset.tab === currentTab));
    results.innerHTML = `
      <div class="section-head">
        <h2>${titleMap[currentTab] || "全部訂單"}</h2>
        <p>${list.length} 筆</p>
      </div>
      <div class="grid">
        ${list.length ? list.map(customerOrderCard).join("") : `<div class="empty card">目前沒有${titleMap[currentTab] || "訂單"}</div>`}
      </div>
    `;
  };

  $$(".orderTab").forEach(button => button.addEventListener("click", () => {
    currentTab = button.dataset.tab;
    render();
  }));

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const formData = new FormData(form);
    const phone = formData.get("phone").trim();
    const orderId = formData.get("orderId").trim();
    if (!phone && !orderId) return;

    let orders = [];
    if (orderId) {
      const order = await findOrderById(orderId);
      orders = order ? [order] : [];
    } else {
      orders = await findOrdersByCustomerId(phone);
    }

    currentOrders = orders.sort(sortByCreatedDesc);
    currentTab = "active";
    render();
  });
}

async function findOrdersByCustomerId(customerId) {
  const [customerSnap, phoneSnap] = await Promise.all([
    getDocs(query(collection(db, "orders"), where("customerId", "==", customerId))),
    getDocs(query(collection(db, "orders"), where("phone", "==", customerId)))
  ]);
  const ordersById = new Map();
  [...customerSnap.docs, ...phoneSnap.docs].forEach(item => {
    const order = normalizeOrder(item.data());
    ordersById.set(order.orderId, order);
  });
  return [...ordersById.values()];
}

function customerOrderCard(order) {
  if (historyOrderStatuses.includes(order.status)) return historyOrderCompactCard(order);

  return `
    <article class="card card-body compact-order compact-order-link">
      <a class="compact-order-main" href="order-detail.html?id=${order.orderId}">
        <h3>${order.productName}</h3>
        <p class="meta">${order.quantity} 份 · ${money(order.totalAmount)}</p>
        <p class="meta">取貨 ${dateText(order.pickupTime)} · ${order.pickupLocation || "-"}</p>
      </a>
      ${statusBadge(order.status)}
    </article>
  `;
}

function historyOrderCompactCard(order) {
  return `
    <article class="card card-body compact-order">
      <div>
        <h3>${order.productName}</h3>
        <p class="meta">${orderDateText(order)} · ${order.quantity} 份 · ${money(order.totalAmount)}</p>
      </div>
      ${statusBadge(order.status)}
    </article>
  `;
}

function requireAdmin(callback) {
  onAuthStateChanged(auth, user => {
    if (!user) {
      location.href = "admin-login.html";
      return;
    }
    callback(user);
  });
}

function initLogout() {
  $$(".logoutBtn").forEach(button => button.addEventListener("click", async () => {
    await signOut(auth);
    location.href = "admin-login.html";
  }));
}

function initLogin() {
  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await signInWithEmailAndPassword(auth, form.get("email"), form.get("password"));
      location.href = "admin.html";
    } catch (error) {
      alert("登入失敗，請確認 Email 與密碼。");
    }
  });
}

async function allProducts() {
  const snap = await getDocs(collection(db, "products"));
  await syncExpiredProducts(snap.docs);
  return snap.docs.map(item => normalizeProduct(item.id, item.data())).sort(sortByCreatedDesc);
}

async function syncExpiredProducts(productDocs) {
  const now = new Date();
  const updates = productDocs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(product => product.isActive !== false && product.saleEnd && new Date(product.saleEnd) < now)
    .map(product => updateDoc(doc(db, "products", product.id), { isActive: false, updatedAt: serverTimestamp() }));
  if (!updates.length) return;
  await Promise.allSettled(updates);
}

async function allOrders() {
  const snap = await getDocs(collection(db, "orders"));
  await syncExpiredPickupOrders(snap.docs);
  return snap.docs.map(item => normalizeOrder(item.data())).sort(sortByCreatedDesc);
}

async function syncExpiredPickupOrders(orderDocs) {
  const updates = orderDocs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(order => !["已取貨", "已取消", "未取貨"].includes(order.status) && isPastPickupDate(order.pickupTime))
    .map(order => updateDoc(doc(db, "orders", order.id), { status: "未取貨", updatedAt: serverTimestamp() }));

  if (!updates.length) return;
  await Promise.allSettled(updates);
}

function sortByCreatedDesc(a, b) {
  return createdAtMillis(b) - createdAtMillis(a);
}

function createdAtMillis(order) {
  if (order.createdAt?.toMillis) return order.createdAt.toMillis();
  if (order.createdAt) return new Date(order.createdAt).getTime() || 0;
  return 0;
}

function orderDateText(order) {
  if (order.createdAt?.toDate) return dateText(order.createdAt.toDate());
  return dateText(order.createdAt);
}

async function initDashboard() {
  requireAdmin(async () => {
    const [products, orders] = await Promise.all([allProducts(), allOrders()]);
    const today = new Date().toDateString();
    $("#totalProducts").textContent = products.length;
    $("#totalOrders").textContent = orders.length;
    $("#todayOrders").textContent = orders.filter(order => order.createdAt?.toDate?.().toDateString() === today).length;
    $("#pickupOrders").textContent = orders.filter(order => order.status === "可取貨").length;
  });
}

function productForm(product = {}) {
  return `
    <form class="form" id="productForm">
      <input type="hidden" name="id" value="${product.id || ""}">
      <div class="field"><label>商品名稱</label><input name="name" value="${product.name || ""}" required></div>
      <div class="field"><label>價格</label><input name="price" type="number" min="0" value="${product.price || ""}" required></div>
      <div class="field"><label>分類</label><input name="category" value="${product.category || "其他"}" placeholder="水果、冷凍、日用品"></div>
      <div class="field"><label>規格</label><input name="spec" value="${product.spec || ""}" required></div>
      <div class="field"><label>描述</label><textarea name="description">${product.description || ""}</textarea></div>
      <div class="field"><label>商品圖片（可直接上傳）</label><input name="image" type="file" accept="image/*"></div>
      ${product.imageUrl ? `<div class="field"><label>目前圖片</label><img class="form-image-preview" src="${product.imageUrl}" alt="${product.name || "商品圖片"}"></div>` : ""}
      <div class="field"><label>截單時間</label><input name="deadline" type="datetime-local" value="${toLocalInput(product.deadline)}" required></div>
      <div class="field"><label>取貨時間</label><input name="pickupTime" type="datetime-local" value="${toLocalInput(product.pickupTime)}" required></div>
      <div class="field"><label>取貨地點</label><input name="pickupLocation" value="${product.pickupLocation || ""}" required></div>
      <div class="field"><label>限量數量（選填）</label><input name="stockLimit" type="number" min="1" value="${isProductUnlimited(product) ? "" : product.stockLimit || ""}" placeholder="空白代表不限量"></div>
      <div class="field"><label>開始販售（選填）</label><input name="saleStart" type="datetime-local" value="${toLocalInput(product.saleStart)}"></div>
      <div class="field"><label>結束販售（選填）</label><input name="saleEnd" type="datetime-local" value="${toLocalInput(product.saleEnd)}"></div>
      <div class="field"><label>是否上架</label><select name="isActive"><option value="true" ${product.isActive !== false ? "selected" : ""}>上架</option><option value="false" ${product.isActive === false ? "selected" : ""}>下架</option></select></div>
      <button class="btn">儲存商品</button>
    </form>
  `;
}

function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

async function uploadProductImage(file) {
  if (!file || !file.size) return "";
  return compressImageToDataUrl(file);
}

function compressImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxSize = 900;
        const scale = Math.min(maxSize / image.width, maxSize / image.height, 1);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function initAdminProducts() {
  requireAdmin(async () => {
    const modal = $("#productModal");
    const panel = $("#productModalPanel");
    const render = async () => {
      const products = (await allProducts()).sort((a, b) => Number(b.isActive !== false) - Number(a.isActive !== false));
      $("#productsTable").innerHTML = products.map(product => `
        <tr>
          <td>${product.name}<br><span class="meta">${product.category || "其他"} · ${product.spec}</span></td>
          <td>${money(product.price)}</td>
          <td>${product.soldCount || 0} / ${isProductUnlimited(product) ? "不限量" : product.stockLimit || 0}</td>
          <td><span class="status ${product.isActive ? "status-green" : "status-gray"}">${product.isActive ? "上架" : "下架"}</span></td>
          <td>
            <button class="btn secondary inline editProduct" data-id="${product.id}">編輯</button>
            <button class="btn danger inline deleteProduct" data-id="${product.id}">刪除</button>
          </td>
        </tr>
      `).join("") || `<tr><td colspan="5" class="empty">尚無商品</td></tr>`;

      $$(".editProduct").forEach(button => button.addEventListener("click", () => {
        const product = products.find(item => item.id === button.dataset.id);
        openProductModal(product);
      }));
      $$(".deleteProduct").forEach(button => button.addEventListener("click", async () => {
        if (confirm("確認刪除此商品？")) {
          await deleteDoc(doc(db, "products", button.dataset.id));
          await render();
        }
      }));
    };

    const openProductModal = product => {
      panel.innerHTML = `<button class="modal-close" id="closeProductModal" type="button" aria-label="關閉">×</button><h2>${product?.id ? "編輯商品" : "新增商品"}</h2>${productForm(product)}`;
      modal.classList.add("open");
      $("#closeProductModal").addEventListener("click", () => modal.classList.remove("open"), { once: true });
      $("#productForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const id = form.get("id") || doc(collection(db, "products")).id;
        const imageUrl = await uploadProductImage(form.get("image"));
        const stockLimitValue = form.get("stockLimit");
        const stockLimit = stockLimitValue ? Number(stockLimitValue) : 0;
        const stockUnlimited = !stockLimitValue;
        const payload = {
          id,
          name: form.get("name").trim(),
          price: Number(form.get("price")),
          category: form.get("category").trim() || "其他",
          spec: form.get("spec").trim(),
          description: form.get("description").trim(),
          deadline: new Date(form.get("deadline")).toISOString(),
          pickupTime: new Date(form.get("pickupTime")).toISOString(),
          pickupLocation: form.get("pickupLocation").trim(),
          stockUnlimited,
          stockLimit,
          saleStart: form.get("saleStart") ? new Date(form.get("saleStart")).toISOString() : "",
          saleEnd: form.get("saleEnd") ? new Date(form.get("saleEnd")).toISOString() : "",
          soldCount: Number(product?.soldCount || 0),
          isActive: form.get("isActive") === "true",
          updatedAt: serverTimestamp()
        };
        payload.imageUrl = imageUrl || product?.imageUrl || "";
        if (!product?.id) payload.createdAt = serverTimestamp();
        await setDoc(doc(db, "products", id), payload, { merge: true });
        modal.classList.remove("open");
        await render();
      });
    };

    $("#newProductBtn").addEventListener("click", () => openProductModal());
    await render();
    const productDraft = sessionStorage.getItem("productDraftFromWish");
    if (productDraft) {
      sessionStorage.removeItem("productDraftFromWish");
      try {
        openProductModal(JSON.parse(productDraft));
      } catch (error) {
        openProductModal();
      }
    }
  });
}

async function allAnnouncements() {
  const snap = await getDocs(collection(db, "announcements"));
  return snap.docs.map(item => normalizeAnnouncement(item.id, item.data())).sort((a, b) => createdAtMillis(b) - createdAtMillis(a));
}

function announcementForm(announcement = {}) {
  return `
    <form class="form" id="announcementForm">
      <input type="hidden" name="id" value="${announcement.id || ""}">
      <div class="field"><label>公告標題</label><input name="title" value="${announcement.title || ""}" required></div>
      <div class="field"><label>公告內容</label><textarea name="content" required>${announcement.content || ""}</textarea></div>
      <div class="field"><label>公告類型</label><select name="type">${announcementTypes.map(type => `<option value="${type}" ${type === announcement.type ? "selected" : ""}>${type}</option>`).join("")}</select></div>
      <div class="field"><label>是否顯示</label><select name="isActive"><option value="true" ${announcement.isActive !== false ? "selected" : ""}>上架</option><option value="false" ${announcement.isActive === false ? "selected" : ""}>下架</option></select></div>
      <div class="field"><label>置頂</label><select name="pinned"><option value="false" ${!announcement.pinned ? "selected" : ""}>不置頂</option><option value="true" ${announcement.pinned ? "selected" : ""}>置頂</option></select></div>
      <button class="btn">儲存公告</button>
    </form>
  `;
}

async function initAdminAnnouncements() {
  requireAdmin(async () => {
    const modal = $("#announcementModal");
    const panel = $("#announcementModalPanel");

    const render = async () => {
      const announcements = await allAnnouncements();
      $("#announcementsTable").innerHTML = announcements.map(announcement => `
        <article class="card card-body">
          <div class="section-head">
            <h3>${announcement.title}</h3>
            <div class="pill-row">
              <span class="pill">${announcement.type}</span>
              ${announcement.pinned ? `<span class="status status-blue">置頂</span>` : ""}
              <span class="status ${announcement.isActive ? "status-green" : "status-gray"}">${announcement.isActive ? "上架" : "下架"}</span>
            </div>
          </div>
          <p>${announcement.content}</p>
          <p class="meta">${orderDateText(announcement)}</p>
          <div class="pill-row">
            <button class="btn secondary inline editAnnouncement" data-id="${announcement.id}">編輯</button>
            <button class="btn danger inline deleteAnnouncement" data-id="${announcement.id}">刪除</button>
          </div>
        </article>
      `).join("") || `<div class="empty card">尚無公告</div>`;

      $$(".editAnnouncement").forEach(button => button.addEventListener("click", () => {
        const announcement = announcements.find(item => item.id === button.dataset.id);
        openAnnouncementModal(announcement);
      }));
      $$(".deleteAnnouncement").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("確認刪除此公告？")) return;
        await deleteDoc(doc(db, "announcements", button.dataset.id));
        await render();
      }));
    };

    const openAnnouncementModal = announcement => {
      panel.innerHTML = `<h2>${announcement?.id ? "編輯公告" : "新增公告"}</h2>${announcementForm(announcement)}`;
      modal.classList.add("open");
      $("#announcementForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const id = form.get("id") || doc(collection(db, "announcements")).id;
        const payload = {
          title: form.get("title").trim(),
          content: form.get("content").trim(),
          type: form.get("type"),
          isActive: form.get("isActive") === "true",
          pinned: form.get("pinned") === "true",
          updatedAt: serverTimestamp()
        };
        if (!announcement?.id) payload.createdAt = serverTimestamp();
        await setDoc(doc(db, "announcements", id), payload, { merge: true });
        modal.classList.remove("open");
        await render();
      });
    };

    $("#newAnnouncementBtn").addEventListener("click", () => openAnnouncementModal());
    $("#closeAnnouncementModal").addEventListener("click", () => modal.classList.remove("open"));
    await render();
  });
}

function orderRow(order) {
  return `
    <tr class="${order.cancelRequested ? "highlight-row" : ""}">
      <td><a href="order-detail.html?id=${order.orderId}&admin=1">${order.orderId}</a></td>
      <td>${order.customerName}<br><span class="meta">${order.phone}</span>${order.cancelRequested ? `<br><span class="status status-orange">取消申請</span>` : ""}</td>
      <td>${order.productName}${order.adminNote ? `<br><span class="meta">內部備註：${order.adminNote}</span>` : ""}</td>
      <td>${order.quantity}</td>
      <td>${money(order.totalAmount)}</td>
      <td>${statusBadge(order.status)}</td>
    </tr>
  `;
}

async function initAdminOrders() {
  requireAdmin(async () => {
    let orders = await allOrders();
    let textFilter = "";
    let categoryFilter = "";
    let statusFilter = "";

    const filterOrders = () => {
      return orders.filter(order => {
        const matchesText = !textFilter || [order.orderId, order.customerName, order.phone, order.productName].some(value => String(value || "").toLowerCase().includes(textFilter));
        const matchesCategory = !categoryFilter || order.productName === categoryFilter;
        const matchesStatus = !statusFilter || order.status === statusFilter;
        return matchesText && matchesCategory && matchesStatus;
      });
    };

    const categories = [...new Set(orders.map(order => order.productName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    $("#orderCategoryFilter").innerHTML = `<option value="">全部品項</option>${categories.map(name => `<option value="${name}">${name}</option>`).join("")}`;

    const render = list => {
      $("#ordersTable").innerHTML = list.map(orderRow).join("") || `<tr><td colspan="6" class="empty">查無訂單</td></tr>`;
    };
    const refreshBatchButton = () => {
      $("#markProductPickupBtn").hidden = !categoryFilter;
    };
    render(filterOrders());
    $("#orderFilter").addEventListener("input", event => {
      textFilter = event.target.value.trim().toLowerCase();
      render(filterOrders());
    });
    $("#orderCategoryFilter").addEventListener("change", event => {
      categoryFilter = event.target.value;
      refreshBatchButton();
      render(filterOrders());
    });
    $("#statusFilter").addEventListener("change", event => {
      statusFilter = event.target.value;
      render(filterOrders());
    });
    $("#exportCsvBtn").addEventListener("click", () => exportCsv(filterOrders()));
    $("#purchaseListBtn").addEventListener("click", () => {
      renderPurchaseList(filterOrders());
    });
    $("#markProductPickupBtn").addEventListener("click", async () => {
      if (!categoryFilter) return;
      const targetOrders = orders.filter(order => order.productName === categoryFilter && order.status === "已下單");
      if (!targetOrders.length) {
        alert(`「${categoryFilter}」目前沒有需要改成可取貨的已下單訂單。`);
        return;
      }
      if (!confirm(`確定要將「${categoryFilter}」的 ${targetOrders.length} 筆已下單訂單全部改為可取貨嗎？`)) return;
      const button = $("#markProductPickupBtn");
      button.disabled = true;
      button.textContent = "更新中...";
      try {
        await Promise.all(targetOrders.map(order => updateDoc(doc(db, "orders", order.orderId), {
          status: "可取貨",
          updatedAt: serverTimestamp()
        })));
        orders = await allOrders();
        render(filterOrders());
        alert(`已將「${categoryFilter}」${targetOrders.length} 筆訂單改為可取貨。`);
      } catch (error) {
        alert("更新失敗，請確認網路或 Firestore 權限。");
      } finally {
        button.disabled = false;
        button.textContent = "此品項全部改為可取貨";
        refreshBatchButton();
      }
    });

  });
}

function orderForm(order) {
  return `
    <form class="form" id="orderFormAdmin">
      <div class="field"><label>客人姓名</label><input name="customerName" value="${order.customerName || ""}" required></div>
      <div class="field"><label>電話</label><input name="phone" value="${order.phone || ""}" required></div>
      <div class="field"><label>LINE ID</label><input name="lineId" value="${order.lineId || ""}"></div>
      <div class="field"><label>數量</label><input name="quantity" type="number" min="1" value="${order.quantity || 1}" required></div>
      <div class="field"><label>客人備註</label><div class="readonly-note">${order.note || "-"}</div></div>
      <div class="field"><label>管理端備註</label><textarea name="adminNote">${order.adminNote || ""}</textarea></div>
      <div class="field"><label>狀態</label><select name="status">${statusOptions.map(status => `<option value="${status}" ${status === order.status ? "selected" : ""}>${status}</option>`).join("")}</select></div>
      <button class="btn">儲存訂單</button>
    </form>
  `;
}

function openOrderEditModal(order) {
  const modal = $("#orderModal");
  const panel = $("#orderModalPanel");
  if (!modal || !panel) return;
  panel.innerHTML = `<button class="modal-close" id="closeOrderModal" type="button" aria-label="關閉">×</button><h2>修改訂單</h2>${orderForm(order)}`;
  modal.classList.add("open");
  $("#closeOrderModal")?.addEventListener("click", () => modal.classList.remove("open"), { once: true });
  $("#orderFormAdmin").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await updateOrderWithStock(order, {
        customerName: form.get("customerName").trim(),
        phone: form.get("phone").trim(),
        lineId: form.get("lineId").trim(),
        quantity: Number(form.get("quantity")),
        note: order.note || "",
        adminNote: form.get("adminNote").trim(),
        status: form.get("status")
      });
      alert("訂單已更新。");
      location.reload();
    } catch (error) {
      alert(error.message);
    }
  });
}

async function updateOrderWithStock(order, payload) {
  const orderRef = doc(db, "orders", order.orderId);
  const productRef = doc(db, "products", order.productId);
  const oldQuantity = Number(order.quantity || 0);
  const newQuantity = Number(payload.quantity || 0);
  const oldCountedQuantity = order.status === "已取消" ? 0 : oldQuantity;
  const newCountedQuantity = payload.status === "已取消" ? 0 : newQuantity;
  const diff = newCountedQuantity - oldCountedQuantity;

  await runTransaction(db, async transaction => {
    const productSnap = await transaction.get(productRef);
    if (!productSnap.exists()) throw new Error("找不到商品，無法更新數量。");
    const product = productSnap.data();
    const currentSoldCount = Number(product.soldCount || 0);
    const stockLimit = Number(product.stockLimit || 0);
    const nextSoldCount = currentSoldCount + diff;
    if (!isProductUnlimited(normalizeProduct(productRef.id, product)) && nextSoldCount > stockLimit) throw new Error("修改後會超過商品限量，請調整數量。");
    if (nextSoldCount < 0) throw new Error("商品已售數量不可小於 0。");

    transaction.update(productRef, {
      soldCount: nextSoldCount,
      updatedAt: serverTimestamp()
    });
    transaction.update(orderRef, {
      ...payload,
      customerId: payload.phone,
      totalAmount: Number(order.price || 0) * newQuantity,
      updatedAt: serverTimestamp()
    });
  });
}

async function cancelOrderWithStock(order, extraPayload = {}) {
  const orderRef = doc(db, "orders", order.orderId);
  const productRef = doc(db, "products", order.productId);
  await runTransaction(db, async transaction => {
    if (order.status !== "已取消") {
      const productSnap = await transaction.get(productRef);
      if (productSnap.exists()) {
      const product = productSnap.data();
      const nextSoldCount = Math.max(Number(product.soldCount || 0) - Number(order.quantity || 0), 0);
      transaction.update(productRef, { soldCount: nextSoldCount, updatedAt: serverTimestamp() });
      }
    }
    transaction.update(orderRef, {
      status: "已取消",
      ...extraPayload,
      updatedAt: serverTimestamp()
    });
  });
}

function exportCsv(orders) {
  const headers = ["訂單編號", "姓名", "電話", "商品", "數量", "總金額", "狀態", "取貨時間", "取貨地點", "管理端備註"];
  const rows = orders.map(order => [order.orderId, order.customerName, order.phone, order.productName, order.quantity, order.totalAmount, order.status, order.pickupTime, order.pickupLocation, order.adminNote]);
  const csv = [headers, ...rows].map(row => row.map(value => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `orders-${todayKey()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderPurchaseList(orders) {
  const purchaseListBox = $("#purchaseListBox");
  const stats = generatePurchaseList(orders);
  const lines = Object.values(stats)
    .sort((a, b) => a.productName.localeCompare(b.productName, "zh-Hant"))
    .map(item => `${item.productName} x ${item.quantity}`);

  purchaseListBox.style.display = "block";
  purchaseListBox.innerHTML = `
    <strong>採購清單統計</strong>
    <pre>${lines.length ? lines.join("\n") : "目前沒有需要採購的訂單"}</pre>
  `;
}

function generatePurchaseList(orders) {
  return orders
    .filter(order => order.status === "已下單")
    .reduce((stats, order) => {
      const key = order.productId || order.productName;
      if (!stats[key]) {
        stats[key] = {
          productId: order.productId || "",
          productName: order.productName || "",
          quantity: 0
        };
      }
      stats[key].quantity += Number(order.quantity || 0);
      return stats;
    }, {});
}

async function initPickup() {
  requireAdmin(async () => {
    const orders = await allOrders();
    const readyPickupOrders = orders.filter(order => order.status === "可取貨");
    $("#readyPickupCount").textContent = `${readyPickupOrders.length} 筆`;
    $("#readyPickupList").innerHTML = pickupOrderCards(readyPickupOrders);

    $("#pickupForm").addEventListener("submit", async event => {
      event.preventDefault();
      const keyword = new FormData(event.currentTarget).get("keyword").trim();
      let orders = [];
      if (keyword.startsWith("O")) {
        const order = await findOrderById(keyword);
        orders = order ? [order] : [];
      } else {
        orders = await findOrdersByCustomerId(keyword);
      }
      orders = orders.filter(order => order.status === "可取貨");
      $("#pickupResults").innerHTML = pickupOrderCards(orders);
      bindPickupButtons();
    });
    bindPickupButtons();
  });
}

function pickupOrderCards(orders) {
  return orders.map(order => `
    <div class="card card-body compact-order">
      <div>
        <h3>${order.customerName}</h3>
        <p class="meta">${order.productName} · ${order.quantity} 份</p>
        <p class="meta">${dateText(order.pickupTime)} · ${order.pickupLocation || "-"}</p>
        ${order.adminNote ? `<p class="meta">內部備註：${order.adminNote}</p>` : ""}
      </div>
      <div>
        <p>${statusBadge(order.status)}</p>
        <button class="btn success confirmPickup" data-id="${order.orderId}">確認取貨</button>
      </div>
    </div>
  `).join("") || `<div class="empty card">查無訂單</div>`;
}

function bindPickupButtons() {
  $$(".confirmPickup").forEach(button => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async () => {
      const orderId = button.dataset.id;
      await updateDoc(doc(db, "orders", orderId), { status: "已取貨", updatedAt: serverTimestamp() });
      $$(".confirmPickup").filter(item => item.dataset.id === orderId).forEach(item => item.closest(".card")?.remove());
      const readyCount = $$("#readyPickupList .confirmPickup").length;
      $("#readyPickupCount").textContent = `${readyCount} 筆`;
      if (!readyCount) $("#readyPickupList").innerHTML = `<div class="empty card">查無訂單</div>`;
    });
  });
}

function isToday(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function initWishlist() {
  $("#wishlistForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = doc(collection(db, "wishlists")).id;
    await setDoc(doc(db, "wishlists", id), {
      id,
      customerName: form.get("customerName").trim(),
      phone: form.get("phone").trim(),
      itemName: form.get("itemName").trim(),
      note: form.get("note").trim(),
      status: "新願望",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    event.currentTarget.reset();
    $("#wishlistMessage").innerHTML = `<div class="notice">已收到你的願望清單，我們會列入下次開團參考。</div>`;
  });
}

async function allWishes({ activeOnly = false } = {}) {
  const snap = await getDocs(collection(db, "wishes"));
  return snap.docs
    .map(item => normalizeWish(item.id, item.data()))
    .filter(wish => !activeOnly || wish.isActive !== false)
    .sort((a, b) => Number(b.votes || 0) - Number(a.votes || 0) || createdAtMillis(b) - createdAtMillis(a));
}

function wishCard(wish, { admin = false } = {}) {
  return `
    <article class="card product-card wish-card">
      <img src="${wish.imageUrl || placeholderImage(wish.title || "許願")}" alt="${wish.title}">
      <div class="product-card-body">
        <div class="section-head">
          <h3>${admin ? `<button class="link-button wishDetailBtn" data-id="${wish.id}">${wish.title}</button>` : wish.title}</h3>
          <span class="status status-orange">${Number(wish.votes || 0)} 票</span>
        </div>
        <p class="meta">${wish.description || "沒有補充說明"}</p>
        ${admin ? `<p>${wish.isActive === false ? `<span class="status status-gray">已下架</span>` : `<span class="status status-green">顯示中</span>`}</p>` : ""}
        <div class="pill-row">
          ${admin ? `
            <button class="btn secondary inline toggleWishBtn" data-id="${wish.id}" data-active="${wish.isActive !== false}">${wish.isActive === false ? "上架" : "下架"}</button>
            <button class="btn danger inline deleteWishBtn" data-id="${wish.id}">刪除</button>
          ` : `<button class="btn inline voteWishBtn" data-id="${wish.id}">+1 我也想買</button>`}
        </div>
      </div>
    </article>
  `;
}

function wishDetail(wish) {
  const voters = Array.isArray(wish.voters) ? wish.voters : [];
  return `
    <button class="modal-close" id="closeWishDetailModal" type="button" aria-label="關閉">×</button>
    <div class="section-head">
      <h2>${wish.title}</h2>
      <span class="status status-orange">${Number(wish.votes || 0)} 票</span>
    </div>
    <div class="info-list">
      <div class="info-row"><span>說明</span><strong>${wish.description || "-"}</strong></div>
      <div class="info-row"><span>許願人</span><strong>${wish.customerName || "-"}</strong></div>
      <div class="info-row"><span>許願人手機</span><strong>${wish.phone || "-"}</strong></div>
      <div class="info-row"><span>建立時間</span><strong>${orderDateText(wish)}</strong></div>
      <div class="info-row"><span>狀態</span><strong>${wish.isActive === false ? "已下架" : "顯示中"}</strong></div>
    </div>
    <h3 style="margin-top:18px">+1 手機號碼</h3>
    <div class="pill-row">
      ${voters.length ? voters.map(phone => `<span class="pill">${phone}</span>`).join("") : `<span class="meta">尚無投票紀錄</span>`}
    </div>
    <div class="modal-actions">
      <button class="btn inline" id="createProductFromWishBtn" type="button" data-id="${wish.id}">開團</button>
    </div>
  `;
}

async function initWishPool() {
  let showAllWishes = false;
  const render = async () => {
    const wishes = await allWishes({ activeOnly: true });
    const topWishes = wishes.slice(0, 5);
    const moreWishes = wishes.slice(5);
    $("#topWishList").innerHTML = topWishes.map(wish => wishCard(wish)).join("") || `<div class="empty card">目前還沒有熱門願望</div>`;
    $("#allWishSection").hidden = !showAllWishes;
    $("#showAllWishesBtn").hidden = !moreWishes.length;
    $("#showAllWishesBtn").textContent = showAllWishes ? "查看更少" : "查看更多";
    $("#wishList").innerHTML = showAllWishes ? moreWishes.map(wish => wishCard(wish)).join("") : "";
    bindWishVoteButtons(render);
  };

  $("#showAllWishesBtn").addEventListener("click", async () => {
    showAllWishes = !showAllWishes;
    await render();
  });

  $("#wishForm").addEventListener("submit", async event => {
    event.preventDefault();
    const wishForm = event.currentTarget;
    const submitButton = $("button[type='submit'], button", wishForm);
    submitButton.disabled = true;
    submitButton.textContent = "送出中...";
    try {
      const form = new FormData(wishForm);
      const phone = form.get("phone").trim();
      const imageUrl = await uploadProductImage(form.get("image"));
      const id = doc(collection(db, "wishes")).id;
      await setDoc(doc(db, "wishes", id), {
        id,
        title: form.get("title").trim(),
        description: form.get("description").trim(),
        imageUrl,
        customerName: form.get("customerName").trim(),
        phone,
        votes: 1,
        voters: [phone],
        isActive: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      location.reload();
    } catch (error) {
      submitButton.disabled = false;
      submitButton.textContent = "送出許願";
      $("#wishMessage").innerHTML = `<div class="notice danger">送出失敗，請再試一次。</div>`;
    }
  });

  await render();
}

function bindWishVoteButtons(afterVote) {
  $$(".voteWishBtn").forEach(button => button.addEventListener("click", async () => {
    const phone = prompt("請輸入手機號碼，用來避免重複投票")?.trim();
    if (!phone) return;
    try {
      await voteWish(button.dataset.id, phone);
      alert("已幫你 +1！");
      await afterVote();
    } catch (error) {
      alert(error.message);
    }
  }));
}

async function voteWish(wishId, phone) {
  const wishRef = doc(db, "wishes", wishId);
  await runTransaction(db, async transaction => {
    const snap = await transaction.get(wishRef);
    if (!snap.exists()) throw new Error("找不到這個願望");
    const wish = normalizeWish(snap.id, snap.data());
    if (wish.voters.includes(phone)) throw new Error("你已經投過這個商品");
    transaction.update(wishRef, {
      voters: [...wish.voters, phone],
      votes: Number(wish.votes || 0) + 1,
      updatedAt: serverTimestamp()
    });
  });
}

async function initAdminWishes() {
  requireAdmin(async () => {
    const modal = $("#wishDetailModal");
    const panel = $("#wishDetailPanel");
    const render = async () => {
      const wishes = await allWishes();
      $("#adminWishList").innerHTML = wishes.map(wish => wishCard(wish, { admin: true })).join("") || `<div class="empty card">目前沒有許願商品</div>`;
      $$(".wishDetailBtn").forEach(button => button.addEventListener("click", () => {
        const wish = wishes.find(item => item.id === button.dataset.id);
        if (!wish) return;
        panel.innerHTML = wishDetail(wish);
        modal.classList.add("open");
        $("#closeWishDetailModal").addEventListener("click", () => modal.classList.remove("open"), { once: true });
        $("#createProductFromWishBtn").addEventListener("click", () => {
          sessionStorage.setItem("productDraftFromWish", JSON.stringify({
            name: wish.title || "",
            description: wish.description || "",
            imageUrl: wish.imageUrl || "",
            category: "其他",
            spec: "",
            price: "",
            stockLimit: "",
            stockUnlimited: true,
            isActive: true
          }));
          location.href = "admin-products.html?fromWish=1";
        });
      }));
      $$(".toggleWishBtn").forEach(button => button.addEventListener("click", async () => {
        await updateDoc(doc(db, "wishes", button.dataset.id), {
          isActive: button.dataset.active !== "true",
          updatedAt: serverTimestamp()
        });
        await render();
      }));
      $$(".deleteWishBtn").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("確認刪除此願望？")) return;
        await deleteDoc(doc(db, "wishes", button.dataset.id));
        await render();
      }));
    };
    await render();
  });
}

export function calculateCustomerStats(orders, customerId) {
  const customerOrders = orders.map(normalizeOrder).filter(order => !customerId || order.customerId === customerId || order.phone === customerId);
  return {
    orderCount: customerOrders.length,
    totalAmount: customerOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    lastOrderAt: customerOrders.reduce((latest, order) => {
      const value = createdAtMillis(order);
      return value > latest ? value : latest;
    }, 0)
  };
}

export function calculateProductStats(orders, productId) {
  const productOrders = orders.map(normalizeOrder).filter(order => !productId || order.productId === productId);
  return productOrders.reduce((stats, order) => {
    const key = order.productId || order.productName || "unknown";
    if (!stats[key]) {
      stats[key] = {
        productId: order.productId || "",
        productName: order.productName || "",
        soldQuantity: 0,
        salesAmount: 0
      };
    }
    stats[key].soldQuantity += Number(order.quantity || 0);
    stats[key].salesAmount += Number(order.totalAmount || 0);
    return stats;
  }, {});
}

initLogout();

const page = document.body.dataset.page;
const pages = {
  home: initHome,
  publicProducts: initPublicProducts,
  product: initProductDetail,
  success: initOrderSuccess,
  search: initOrderSearch,
  wishlist: initWishlist,
  wish: initWishPool,
  detail: initOrderDetail,
  login: initLogin,
  admin: initDashboard,
  products: initAdminProducts,
  orders: initAdminOrders,
  pickup: initPickup,
  announcements: initAdminAnnouncements,
  adminWishes: initAdminWishes
};

pages[page]?.();
