import {
  auth,
  db,
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
  deleteField,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  runTransaction
} from "./firebase.js";

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const money = value => `NT$ ${Number(value || 0).toLocaleString("zh-TW")}`;
const toDate = value => {
  if (!value) return null;
  if (value?.toDate) return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const dateText = value => {
  const date = toDate(value);
  return date ? date.toLocaleString("zh-TW", { hour12: false }) : "-";
};
const todayKey = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const withTimeout = (promise, message = "連線逾時，請檢查網路後再試一次。", ms = 12000) => {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
};

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

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
function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function statusBadge(status) {
  const normalizedStatus = normalizeOrderStatus(status);
  return `<span class="status status-${statusMap[normalizedStatus] || "blue"}">${normalizedStatus}</span>`;
}

function placeholderImage(name = "社區團購") {
  const label = escapeHtml(String(name || "社區團購").slice(0, 8));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" fill="#dbeafe"/><circle cx="450" cy="120" r="120" fill="#bfdbfe"/><rect x="110" y="150" width="380" height="300" rx="32" fill="#fff"/><text x="300" y="315" text-anchor="middle" font-family="Arial" font-size="42" font-weight="700" fill="#2563eb">${label}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function normalizeProduct(id, data) {
  const product = { id, soldCount: 0, stockLimit: 0, stockUnlimited: false, isActive: true, category: "其他", saleStart: "", saleEnd: "", imageUrl: "", imageUrls: [], ...data };
  product.hasEmbeddedImages = Array.isArray(data.imageUrls) && data.imageUrls.some(Boolean);
  const imageUrls = Array.isArray(product.imageUrls) ? product.imageUrls.filter(Boolean) : [];
  product.imageUrls = imageUrls.length ? imageUrls : (product.imageUrl ? [product.imageUrl] : []);
  product.imageUrl = product.imageUrls[0] || "";
  return product;
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
    adminReply: "",
    reply: "",
    adminResponse: "",
    isAccepted: false,
    accepted: false,
    isOpened: false,
    opened: false,
    productId: "",
    groupProductId: "",
    status: "",
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
  const products = snap.docs
    .map(item => normalizeProduct(item.id, item.data()))
    .filter(product => isProductOnSale(product) && !isProductDeadlinePassed(product))
    .sort((a, b) => (toDate(a.deadline)?.getTime() || Infinity) - (toDate(b.deadline)?.getTime() || Infinity));
  return products;
}

async function activeProductsPage({ category = "全部", cursor = null, pageSize = 10 } = {}) {
  try {
    return await indexedActiveProductsPage({ category, cursor, pageSize });
  } catch (error) {
    console.warn("Indexed product page unavailable; using scan fallback", error);
    return scannedActiveProductsPage({ category, cursor, pageSize });
  }
}

async function indexedActiveProductsPage({ category = "全部", cursor = null, pageSize = 10 } = {}) {
  const constraints = [
    where("isActive", "==", true),
    where("deadline", ">=", new Date().toISOString()),
    orderBy("deadline"),
    limit(pageSize + 1)
  ];
  if (category !== "全部") constraints.splice(1, 0, where("category", "==", category));
  if (cursor) constraints.splice(-1, 0, startAfter(cursor));
  const snap = await getDocs(query(collection(db, "products"), ...constraints));
  const visibleDocs = snap.docs.slice(0, pageSize);
  const products = visibleDocs
    .map(item => normalizeProduct(item.id, item.data()))
    .filter(isProductOnSale);

  return {
    products,
    cursor: visibleDocs[visibleDocs.length - 1] || null,
    hasNext: snap.docs.length > pageSize
  };
}

async function scannedActiveProductsPage({ category = "全部", cursor = null, pageSize = 10 } = {}) {
  let scanCursor = cursor;
  let hasMoreDocs = true;
  const products = [];

  while (products.length < pageSize && hasMoreDocs) {
    const constraints = [orderBy("deadline"), limit(Math.max(pageSize - products.length, 1))];
    if (scanCursor) constraints.splice(1, 0, startAfter(scanCursor));
    const snap = await getDocs(query(collection(db, "products"), ...constraints));
    hasMoreDocs = snap.docs.length === pageSize;
    scanCursor = snap.docs[snap.docs.length - 1] || scanCursor;
    products.push(...snap.docs
      .map(item => normalizeProduct(item.id, item.data()))
      .filter(product => product.isActive !== false)
      .filter(product => category === "全部" || (product.category || "其他") === category)
      .filter(product => isProductOnSale(product) && !isProductDeadlinePassed(product)));
  }

  return {
    products: products.slice(0, pageSize),
    cursor: scanCursor,
    hasNext: hasMoreDocs
  };
}

function debounce(callback, delay = 120) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function isProductUnlimited(product) {
  return product.stockUnlimited === true || Number(product.stockLimit || 0) <= 0;
}

function productRemainingCount(product) {
  if (isProductUnlimited(product)) return null;
  return Math.max(Number(product.stockLimit || 0) - Number(product.soldCount || 0), 0);
}

function productRemainingText(product) {
  if (isProductUnlimited(product)) return "不限量";
  return `剩餘 ${productRemainingCount(product)}`;
}

function deadlineCountdownText(value) {
  const deadline = toDate(value);
  if (!deadline) return "";
  const diff = deadline.getTime() - Date.now();
  if (diff <= 0) return "已截止";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `剩 ${minutes} 分`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `剩 ${hours} 小時`;
  return `剩 ${Math.ceil(hours / 24)} 天`;
}

function isDeadlineSoon(value, maxHours = 72) {
  const deadline = toDate(value);
  if (!deadline) return false;
  const diff = deadline.getTime() - Date.now();
  return diff > 0 && diff <= maxHours * 60 * 60 * 1000;
}

function productDeadlineBadge(product) {
  if (!product.deadline) return "";
  const label = deadlineCountdownText(product.deadline);
  if (!label || label === "已截止") return "";
  const urgent = isDeadlineSoon(product.deadline, 24);
  return `<span class="status ${urgent ? "status-red" : "status-orange"}">${label}</span>`;
}

function sortProducts(products, sort = "latest") {
  const list = [...products];
  const sorters = {
    latest: (a, b) => createdAtMillis(b) - createdAtMillis(a),
    popular: (a, b) => Number(b.soldCount || 0) - Number(a.soldCount || 0) || createdAtMillis(b) - createdAtMillis(a),
    "price-desc": (a, b) => Number(b.price || 0) - Number(a.price || 0),
    "price-asc": (a, b) => Number(a.price || 0) - Number(b.price || 0),
    deadline: (a, b) => (toDate(a.deadline)?.getTime() || Infinity) - (toDate(b.deadline)?.getTime() || Infinity)
  };
  return list.sort(sorters[sort] || sorters.latest);
}

function productSearchText(product) {
  return [
    product.name,
    product.brand,
    product.spec,
    product.category
  ].map(value => String(value || "").toLowerCase()).join(" ");
}

function salePeriodText(product) {
  if (!product.saleStart && !product.saleEnd) return "";
  const start = product.saleStart ? compactDateText(product.saleStart) : "現在";
  const end = product.saleEnd ? compactDateText(product.saleEnd) : "售完為止";
  return `<span>開賣 ${start}</span><span>結束 ${end}</span>`;
}

function isProductOnSale(product) {
  const now = new Date();
  if (product.saleStart && new Date(product.saleStart) > now) return false;
  if (product.saleEnd && new Date(product.saleEnd) < now) return false;
  return true;
}

function isProductDeadlinePassed(product) {
  if (!product.deadline) return false;
  return new Date(product.deadline) < new Date();
}

function isProductOrderable(product) {
  return product.isActive !== false && isProductOnSale(product) && !isProductDeadlinePassed(product);
}

function compactDateText(value) {
  const date = toDate(value);
  if (!date) return "-";
  return date.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function stackedDateText(value) {
  const date = toDate(value);
  if (!date) return "-";
  return `
    <span class="datetime-stack">
      <span>${date.toLocaleDateString("zh-TW")}</span>
      <span>${date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
    </span>
  `;
}

function productMainImage(product) {
  return product.imageUrls?.[0] || product.imageUrl || placeholderImage(product.name);
}

async function loadProductImages(product) {
  if (!product?.id) return product.imageUrls?.length ? product.imageUrls : (product.imageUrl ? [product.imageUrl] : []);
  if (product.imageUrls?.length > 1) return product.imageUrls;
  const snap = await getDoc(doc(db, "productImages", product.id));
  if (!snap.exists()) return product.imageUrls?.length ? product.imageUrls : (product.imageUrl ? [product.imageUrl] : []);
  const images = Array.isArray(snap.data().imageUrls) ? snap.data().imageUrls.filter(Boolean) : [];
  product.imageUrls = images.length ? images : product.imageUrls;
  return product.imageUrls;
}

function productGallery(product) {
  const images = product.imageUrls?.length ? product.imageUrls : [productMainImage(product)];
  return `
    <div class="product-gallery" data-gallery>
      <div class="product-slider" data-slider>
        ${images.map((url, index) => `
          <img class="product-image" src="${url}" alt="${escapeHtml(product.name)} ${index + 1}" ${index ? "loading=\"lazy\"" : ""} decoding="async">
        `).join("")}
      </div>
      ${images.length > 1 ? `
        <button class="gallery-arrow gallery-prev" type="button" data-gallery-prev aria-label="上一張">‹</button>
        <button class="gallery-arrow gallery-next" type="button" data-gallery-next aria-label="下一張">›</button>
        <div class="product-thumbs">
          ${images.map((url, index) => `<button class="gallery-thumb ${index === 0 ? "active" : ""}" type="button" data-gallery-index="${index}" aria-label="第 ${index + 1} 張圖片"><img src="${url}" alt="${escapeHtml(product.name)} ${index + 1}" loading="lazy" decoding="async"></button>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function initProductGallery() {
  const gallery = $("[data-gallery]");
  const slider = $("[data-slider]", gallery);
  if (!gallery || !slider) return;

  const thumbs = $$("[data-gallery-index]", gallery);
  const images = $$(".product-image", slider);
  if (images.length <= 1) return;

  const goTo = index => {
    const target = images[index];
    if (!target) return;
    slider.scrollTo({ left: target.offsetLeft, behavior: "smooth" });
  };

  const setActive = () => {
    const index = Math.round(slider.scrollLeft / Math.max(slider.clientWidth, 1));
    thumbs.forEach((thumb, thumbIndex) => thumb.classList.toggle("active", thumbIndex === index));
  };

  thumbs.forEach(thumb => thumb.addEventListener("click", () => goTo(Number(thumb.dataset.galleryIndex))));
  $("[data-gallery-prev]", gallery)?.addEventListener("click", () => goTo(Math.max(Math.round(slider.scrollLeft / slider.clientWidth) - 1, 0)));
  $("[data-gallery-next]", gallery)?.addEventListener("click", () => goTo(Math.min(Math.round(slider.scrollLeft / slider.clientWidth) + 1, images.length - 1)));
  slider.addEventListener("scroll", setActive, { passive: true });
}

async function activeAnnouncements() {
  const snap = await getDocs(query(collection(db, "announcements"), where("isActive", "==", true)));
  return snap.docs
    .map(item => normalizeAnnouncement(item.id, item.data()))
    .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return createdAtMillis(b) - createdAtMillis(a);
    })
    .slice(0, 3);
}

function announcementCard(announcement) {
  return `
    <article class="announcement-item">
      <strong>${escapeHtml(announcement.type || "公告")}</strong>
      <span>${escapeHtml(announcement.content || announcement.title || "")}</span>
    </article>
  `;
}

function productCard(product) {
  return `
    <article class="card product-card">
      <a class="product-card-media" href="product.html?id=${encodeURIComponent(product.id)}">
        <img src="${productMainImage(product)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">
        ${productDeadlineBadge(product) ? `<div class="product-card-badge">${productDeadlineBadge(product)}</div>` : ""}
      </a>
      <div class="product-card-body">
        <div class="product-card-top">
          <span class="pill">${escapeHtml(product.category || "其他")}</span>
          <span class="meta">已售 ${Number(product.soldCount || 0)}</span>
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <div class="price">${money(product.price)}</div>
        <p class="meta">${product.brand ? `${escapeHtml(product.brand)} · ` : ""}${escapeHtml(product.spec || "無規格")}</p>
        <div class="product-card-stats">
          <span>剩餘 <strong>${isProductUnlimited(product) ? "不限量" : productRemainingCount(product)}</strong></span>
          <span>截單 <strong>${compactDateText(product.deadline)}</strong></span>
        </div>
        <a class="btn" href="product.html?id=${encodeURIComponent(product.id)}">我想預訂</a>
      </div>
    </article>
  `;
}

async function initHome() {
  const announcementList = $("#announcementList");
  const hotProductList = $("#hotProductList");
  const latestProductList = $("#latestProductList");
  const endingProductList = $("#endingProductList");
  announcementList.innerHTML = `<span>公告讀取中...</span>`;
  [hotProductList, latestProductList, endingProductList].forEach(root => {
    if (root) root.innerHTML = `<div class="empty card">商品讀取中...</div>`;
  });
  const [announcements, products] = await Promise.all([activeAnnouncements(), activeProducts()]);
  announcementList.innerHTML = announcements.length ? announcements.map(announcementCard).join("") : `<article class="announcement-item"><span>目前沒有新的公告</span></article>`;
  renderHomeProductSections({ hotProductList, latestProductList, endingProductList }, products);
  let renderedLimit = featuredProductLimit();
  window.addEventListener("resize", debounce(() => {
    const nextLimit = featuredProductLimit();
    if (nextLimit === renderedLimit) return;
    renderedLimit = nextLimit;
    renderHomeProductSections({ hotProductList, latestProductList, endingProductList }, products);
  }));
}

function renderHomeProductSections(roots, products) {
  const hotProducts = sortProducts(products, "popular").slice(0, 3);
  const latestProducts = sortProducts(products, "latest").slice(0, featuredProductLimit());
  const endingProducts = sortProducts(products, "deadline").slice(0, 4);
  if (roots.hotProductList) roots.hotProductList.innerHTML = hotProducts.map(hotProductCard).join("") || `<div class="empty card">目前沒有熱門商品</div>`;
  if (roots.latestProductList) roots.latestProductList.innerHTML = latestProducts.map(productCard).join("") || `<div class="empty card">目前沒有新上架商品</div>`;
  if (roots.endingProductList) roots.endingProductList.innerHTML = endingProducts.map(endingProductCard).join("") || `<div class="empty card">目前沒有即將截止商品</div>`;
}

function hotProductCard(product, index) {
  return `
    <article class="card rank-card">
      <a class="rank-card-media" href="product.html?id=${encodeURIComponent(product.id)}">
        <img src="${productMainImage(product)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">
        <span class="rank-badge">第 ${index + 1} 名</span>
      </a>
      <div class="rank-card-body">
        <span class="pill">${escapeHtml(product.category || "其他")}</span>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="meta">${product.brand ? `${escapeHtml(product.brand)} · ` : ""}${escapeHtml(product.spec || "無規格")}</p>
        <div class="rank-card-foot">
          <strong class="price">${money(product.price)}</strong>
          <span class="meta">已售 ${Number(product.soldCount || 0)}</span>
        </div>
      </div>
    </article>
  `;
}

function endingProductCard(product) {
  return `
    <article class="card ending-card">
      <img src="${productMainImage(product)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">
      <div>
        <div class="pill-row">
          ${productDeadlineBadge(product)}
          <span class="pill">${escapeHtml(product.category || "其他")}</span>
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="meta">${escapeHtml(product.spec || "無規格")} · ${productRemainingText(product)}</p>
        <strong class="price">${money(product.price)}</strong>
      </div>
      <a class="btn secondary inline" href="product.html?id=${encodeURIComponent(product.id)}">查看</a>
    </article>
  `;
}

function featuredProductLimit() {
  return window.matchMedia("(max-width: 767px)").matches ? 6 : 5;
}

async function initPublicProducts() {
  const productList = $("#productList");
  const categoryFilter = $("#categoryFilter");
  const searchInput = $("#productSearch");
  const sortSelect = $("#productSort");
  productList.innerHTML = `<div class="empty card">商品讀取中...</div>`;
  let products = await activeProducts();
  let categories = await publicProductCategories();
  const productDerivedCategories = [...new Set(products.map(product => product.category || "其他"))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  categories = [...new Set([...categories, ...productDerivedCategories])];
  let selectedCategory = "全部";
  let currentPage = 1;
  const pageSize = 12;

  const filteredProducts = () => {
    const keyword = searchInput.value.trim().toLowerCase();
    const filtered = products.filter(product => {
      const matchesCategory = selectedCategory === "全部" || (product.category || "其他") === selectedCategory;
      const matchesKeyword = !keyword || productSearchText(product).includes(keyword);
      return matchesCategory && matchesKeyword;
    });
    return sortProducts(filtered, sortSelect.value);
  };

  const render = () => {
    const list = filteredProducts();
    const totalPages = Math.max(Math.ceil(list.length / pageSize), 1);
    currentPage = Math.min(currentPage, totalPages);
    const visible = list.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    productList.innerHTML = visible.length
      ? `${visible.map(productCard).join("")}${totalPages > 1 ? `
          <div class="pagination">
            <button class="btn secondary inline" type="button" data-page-prev ${currentPage === 1 ? "disabled" : ""}>上一頁</button>
            <span class="meta">第 ${currentPage} / ${totalPages} 頁，共 ${list.length} 件</span>
            <button class="btn secondary inline" type="button" data-page-next ${currentPage === totalPages ? "disabled" : ""}>下一頁</button>
          </div>
        ` : ""}`
      : `<div class="empty card">找不到符合條件的商品</div>`;
    $("[data-page-prev]", productList)?.addEventListener("click", () => {
      currentPage -= 1;
      render();
      productList.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("[data-page-next]", productList)?.addEventListener("click", () => {
      currentPage += 1;
      render();
      productList.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const handleCategoryChange = category => {
    selectedCategory = category;
    currentPage = 1;
    renderCategoryFilter(categoryFilter, categories, selectedCategory, handleCategoryChange);
    render();
  };

  renderCategoryFilter(categoryFilter, categories, selectedCategory, handleCategoryChange);
  searchInput.addEventListener("input", debounce(() => {
    currentPage = 1;
    render();
  }, 160));
  sortSelect.addEventListener("change", () => {
    currentPage = 1;
    render();
  });
  render();
}

async function publicProductCategories() {
  try {
    const snap = await getDocs(collection(db, "productCategories"));
    const categories = snap.docs.map(item => item.data().name || item.id).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    if (categories.length) return ["全部", ...new Set(categories)];
  } catch (error) {
    console.warn("Product categories unavailable", error);
  }
  return ["全部"];
}

function renderCategoryFilter(categoryFilter, categories, selectedCategory, onChange) {
  categoryFilter.dataset.selectedCategory = selectedCategory;
  categoryFilter.innerHTML = categories.map(category => `<button class="chip ${category === selectedCategory ? "active" : ""}" type="button" data-category="${category}">${category}</button>`).join("");
  $$(".chip", categoryFilter).forEach(button => button.addEventListener("click", () => onChange(button.dataset.category)));
}

async function initPagedProductList(productList, categoryFilter, categories) {
  const pageSize = 10;
  let selectedCategory = categoryFilter.dataset.selectedCategory || "全部";
  let currentPage = 1;
  let pages = [];

  const renderProducts = page => {
    productList.innerHTML = page.products.length
      ? `${page.products.map(productCard).join("")}${(currentPage > 1 || page.hasNext) ? `
          <div class="pagination">
            <button class="btn secondary inline" type="button" data-page-prev ${currentPage === 1 ? "disabled" : ""}>上一頁</button>
            <span class="meta">第 ${currentPage} 頁</span>
            <button class="btn secondary inline" type="button" data-page-next ${page.hasNext ? "" : "disabled"}>下一頁</button>
          </div>
        ` : ""}`
      : `<div class="empty card">這個分類目前還沒有商品</div>`;
    $("[data-page-prev]", productList)?.addEventListener("click", () => {
      currentPage -= 1;
      renderProducts(pages[currentPage - 1]);
      productList.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("[data-page-next]", productList)?.addEventListener("click", async () => {
      productList.innerHTML = `<div class="empty card">商品讀取中...</div>`;
      const nextPage = await activeProductsPage({ category: selectedCategory, cursor: pages[currentPage - 1]?.cursor, pageSize });
      pages[currentPage] = nextPage;
      currentPage += 1;
      renderProducts(nextPage);
      productList.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  if (!categories.includes(selectedCategory)) selectedCategory = "全部";
  const loadFirstPage = async () => {
    currentPage = 1;
    pages = [];
    productList.innerHTML = `<div class="empty card">商品讀取中...</div>`;
    const firstPage = await activeProductsPage({ category: selectedCategory, pageSize });
    pages[0] = firstPage;
    renderProducts(firstPage);
  };

  const handleCategoryChange = async category => {
    selectedCategory = category;
    renderCategoryFilter(categoryFilter, categories, selectedCategory, handleCategoryChange);
    await loadFirstPage();
  };

  renderCategoryFilter(categoryFilter, categories, selectedCategory, handleCategoryChange);
  await loadFirstPage();
  return {
    updateCategories(nextCategories) {
      categories = nextCategories;
      if (!categories.includes(selectedCategory)) selectedCategory = "全部";
      renderCategoryFilter(categoryFilter, categories, selectedCategory, handleCategoryChange);
    }
  };
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
  await loadProductImages(product);
  const remaining = Math.max(Number(product.stockLimit || 0) - Number(product.soldCount || 0), 0);
  const canOrder = isProductOrderable(product) && (isProductUnlimited(product) || remaining > 0);
  root.innerHTML = `
    <div class="card">
      ${productGallery(product)}
    </div>
    <div class="card card-body">
      <div class="pill-row">
        <span class="pill">${escapeHtml(product.category || "其他")}</span>
        ${productDeadlineBadge(product)}
      </div>
      <div class="product-title-row">
        <h1>${escapeHtml(product.name)}</h1>
        ${salePeriodText(product) ? `<span class="meta">${salePeriodText(product)}</span>` : ""}
      </div>
      <div class="price">${money(product.price)}</div>
      <div class="product-metrics">
        <div><span>已售</span><strong>${Number(product.soldCount || 0)}</strong></div>
        <div><span>剩餘</span><strong>${isProductUnlimited(product) ? "不限量" : remaining}</strong></div>
        ${product.deadline ? `<div><span>倒數截止</span><strong>${deadlineCountdownText(product.deadline)}</strong></div>` : ""}
      </div>
      <div class="product-description">${escapeHtml(product.description || "")}</div>
      <div class="info-list">
        <div class="info-row"><span>規格</span><strong>${escapeHtml(product.spec || "-")}</strong></div>
        ${product.brand ? `<div class="info-row"><span>品牌</span><strong>${escapeHtml(product.brand)}</strong></div>` : ""}
        <div class="info-row"><span>已售數量</span><strong>${Number(product.soldCount || 0)}</strong></div>
        <div class="info-row"><span>剩餘數量</span><strong>${productRemainingText(product)}</strong></div>
        ${product.deadline ? `<div class="info-row"><span>截單時間</span><strong>${stackedDateText(product.deadline)}</strong></div>` : ""}
        ${product.pickupTime ? `<div class="info-row"><span>取貨時間</span><strong>${stackedDateText(product.pickupTime)}</strong></div>` : ""}
        ${product.pickupLocation ? `<div class="info-row"><span>取貨地點</span><strong>${escapeHtml(product.pickupLocation)}</strong></div>` : ""}
      </div>
      <div class="product-action-row">
        <button class="btn" id="openOrderModalBtn" ${canOrder ? "" : "disabled"}>立即預購</button>
        <button class="btn secondary" id="shareProductBtn" type="button">分享商品</button>
      </div>
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
  $("#shareProductBtn")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    const shareData = {
      title: product.name,
      text: `${product.name} ${money(product.price)}`,
      url: location.href
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await copyText(location.href);
        button.textContent = "已複製連結";
        setTimeout(() => { button.textContent = "分享商品"; }, 1600);
      }
    } catch (error) {
      if (error.name !== "AbortError") alert("分享失敗，請稍後再試。");
    }
  });
  initProductGallery();
  $("#orderForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const quantity = Number(form.get("quantity"));
    const orderId = await nextOrderId();
    const phone = form.get("phone").trim();
    const hashedPhone = await phoneHash(phone);

    try {
      await runTransaction(db, async transaction => {
        const freshSnap = await transaction.get(productRef);
        const fresh = normalizeProduct(productRef.id, freshSnap.data());
        if (!fresh?.isActive) throw new Error("商品目前未上架");
        if (!isProductOnSale(fresh)) throw new Error("商品目前不在販售期間");
        if (isProductDeadlinePassed(fresh)) throw new Error("已超過截單時間");
        if (!isProductUnlimited(fresh) && Number(fresh.soldCount || 0) + quantity > Number(fresh.stockLimit || 0)) throw new Error("剩餘數量不足");

        const orderRef = doc(db, "orders", orderId);
        const publicOrderRef = doc(db, "publicOrders", publicOrderLookupId(orderId));
        const orderData = {
          orderId,
          productId: id,
          productName: fresh.name,
          productCategory: fresh.category || "其他",
          price: Number(fresh.price || 0),
          quantity,
          totalAmount: Number(fresh.price || 0) * quantity,
          customerName: form.get("customerName").trim(),
          phone,
          customerId: phone,
          lineId: form.get("lineId").trim(),
          note: form.get("note").trim(),
          status: "已下單",
          pickupTime: fresh.pickupTime,
          pickupLocation: fresh.pickupLocation,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        transaction.set(orderRef, orderData);
        transaction.set(publicOrderRef, publicOrderPayload(orderData, hashedPhone));
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

function publicOrderLookupId(orderId) {
  return encodeURIComponent(orderId || "");
}

async function sha256Text(value) {
  const data = new TextEncoder().encode(String(value || ""));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256Fallback(data);
  const hashBuffer = await subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Fallback(data) {
  const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const bytes = [...data, 0x80];
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const bitLength = data.length * 8;
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const byteIndex = offset + index * 4;
      words[index] = (
        (bytes[byteIndex] << 24) |
        (bytes[byteIndex + 1] << 16) |
        (bytes[byteIndex + 2] << 8) |
        bytes[byteIndex + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map(value => value.toString(16).padStart(8, "0")).join("");
}

async function phoneHash(phone) {
  return sha256Text(String(phone || "").replace(/\D/g, ""));
}

function publicOrderPayload(order, hashedPhone = order.phoneHash || "") {
  return {
    orderId: order.orderId,
    productName: order.productName,
    productCategory: order.productCategory || "其他",
    price: Number(order.price || 0),
    quantity: Number(order.quantity || 0),
    totalAmount: Number(order.totalAmount || 0),
    status: normalizeOrderStatus(order.status, order.pickupTime),
    pickupTime: order.pickupTime || "",
    pickupLocation: order.pickupLocation || "",
    phoneHash: hashedPhone,
    createdAt: order.createdAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
    cancelRequested: order.cancelRequested || false,
    cancelApproved: order.cancelApproved || false,
    cancelRejected: order.cancelRejected || false,
    cancelRejectReason: order.cancelRejectReason || ""
  };
}

async function findPublicOrderById(orderId) {
  if (!orderId) return null;
  const snap = await getDoc(doc(db, "publicOrders", publicOrderLookupId(orderId)));
  return snap.exists() ? normalizeOrder(snap.data()) : null;
}

async function findPublicOrdersByPhone(phone) {
  if (!phone) return [];
  const hash = await phoneHash(phone);
  const snap = await getDocs(query(collection(db, "publicOrders"), where("phoneHash", "==", hash)));
  return snap.docs.map(item => normalizeOrder(item.data())).sort(sortByCreatedDesc);
}

async function syncPublicOrder(order) {
  if (!order?.orderId || !order?.phone) return;
  await setDoc(doc(db, "publicOrders", publicOrderLookupId(order.orderId)), publicOrderPayload(order, await phoneHash(order.phone)), { merge: true });
  await deleteDoc(doc(db, "publicOrders", `${encodeURIComponent(order.orderId)}_${encodeURIComponent(order.phone)}`)).catch(() => {});
}

function orderSummary(order, options = {}) {
  const isAdmin = options.admin === true;
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
      ${isAdmin ? adminCancelButton(order) : cancelRequestButton(order)}
    </div>
  `;
}

function successOrderSummary(order) {
  const detailHref = `order-detail.html?id=${encodeURIComponent(order.orderId)}`;
  return `
    <section class="success-panel card card-body">
      <div class="success-mark">✓</div>
      <div>
        <p class="eyebrow">預訂已送出</p>
        <h2>${escapeHtml(order.orderId)}</h2>
        <p class="muted">請保留訂單編號，取貨或查詢時會用到。</p>
      </div>
    </section>
    <section class="success-grid">
      <div class="card card-body">
        <div class="section-head">
          <h2>訂單資訊</h2>
          ${statusBadge(order.status)}
        </div>
        <div class="info-list">
          <div class="info-row"><span>訂單編號</span><strong>${escapeHtml(order.orderId)}</strong></div>
          <div class="info-row"><span>下單時間</span><strong>${orderDateText(order)}</strong></div>
          <div class="info-row"><span>總金額</span><strong>${money(order.totalAmount)}</strong></div>
        </div>
      </div>
      <div class="card card-body">
        <h2>商品資訊</h2>
        <div class="order-product-mini">
          <img src="${placeholderImage(order.productName || "商品")}" alt="${escapeHtml(order.productName || "商品")}">
          <div>
            <h3>${escapeHtml(order.productName || "-")}</h3>
            <p class="meta">${escapeHtml(order.productCategory || "其他")} · ${Number(order.quantity || 0)} 份</p>
            <strong class="price">${money(order.price || 0)}</strong>
          </div>
        </div>
      </div>
      <div class="card card-body">
        <h2>取貨資訊</h2>
        <div class="info-list">
          <div class="info-row"><span>取貨時間</span><strong>${dateText(order.pickupTime)}</strong></div>
          <div class="info-row"><span>取貨地點</span><strong>${escapeHtml(order.pickupLocation || "-")}</strong></div>
        </div>
      </div>
      <div class="card card-body success-actions">
        <button class="btn secondary" id="copyOrderIdBtn" type="button" data-copy="${escapeHtml(order.orderId)}">複製訂單編號</button>
        <a class="btn" href="${detailHref}">查看訂單</a>
        <a class="btn secondary" href="products.html">繼續購物</a>
      </div>
    </section>
  `;
}

function cancelRequestInfo(order) {
  if (order.cancelApproved) return `<p class="notice">取消已同意，此訂單已取消。</p>`;
  if (order.cancelRejected) return `<p class="notice">取消申請已被拒絕：${order.cancelRejectReason || "未填寫原因"}</p>`;
  if (order.cancelRequested) return `<p class="notice">取消申請審核中：${order.cancelReason || "未填寫原因"}</p>`;
  return "";
}

function cancelRequestButton(order) {
  return "";
}

function adminCancelButton(order) {
  if (order.status === "已取消") return "";
  return `<button class="btn danger" id="adminCancelOrderBtn" data-id="${order.orderId}">取消訂單</button>`;
}

async function initOrderSuccess() {
  const order = await findPublicOrderById(getParam("id"));
  $("#orderSuccess").innerHTML = order ? successOrderSummary(order) : `<div class="notice">找不到訂單</div>`;
  $("#copyOrderIdBtn")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    await copyText(button.dataset.copy);
    button.textContent = "已複製";
    setTimeout(() => { button.textContent = "複製訂單編號"; }, 1400);
  });
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

  const order = await findPublicOrderById(getParam("id"));
  $("#orderDetail").innerHTML = order ? orderSummary(order) : `<div class="notice">找不到訂單。</div>`;
}

async function initOrderSearch() {
  const form = $("#searchForm");
  const results = $("#searchResults");
  const submitButton = $("button[type='submit'], .btn", form);
  const sortSelect = $("#orderSearchSort");
  let currentOrders = [];
  let currentTab = "all";
  let currentSort = "latest";
  let searchToken = 0;

  const setSearching = isSearching => {
    if (!submitButton) return;
    submitButton.disabled = isSearching;
    submitButton.textContent = isSearching ? "查詢中..." : "查詢訂單";
    form.setAttribute("aria-busy", String(isSearching));
  };

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
    const list = sortOrders(tabMap[currentTab] || currentOrders, currentSort);

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
  sortSelect?.addEventListener("change", event => {
    currentSort = event.target.value;
    render();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const formData = new FormData(form);
    const phone = formData.get("phone").trim();
    const orderId = formData.get("orderId").trim();
    if (!phone && !orderId) {
      results.innerHTML = `<div class="notice">請輸入手機號碼或訂單編號。</div>`;
      return;
    }

    const token = ++searchToken;
    setSearching(true);
    results.innerHTML = `<div class="empty card">訂單查詢中...</div>`;

    try {
      let orders = [];
      if (orderId) {
        const order = await withTimeout(findPublicOrderById(orderId));
        orders = order ? [order] : [];
      } else {
        orders = await withTimeout(findPublicOrdersByPhone(phone));
      }

      if (token !== searchToken) return;
      currentOrders = sortOrders(orders, "latest");
      currentTab = "active";
      render();
    } catch (error) {
      if (token !== searchToken) return;
      console.error(error);
      currentOrders = [];
      results.innerHTML = `<div class="notice">查詢失敗：${escapeHtml(error.message || "請稍後再試。")}</div>`;
    } finally {
      if (token === searchToken) setSearching(false);
    }
  });
}

function sortOrders(orders, direction = "latest") {
  return [...orders].sort((a, b) => {
    const diff = createdAtMillis(a) - createdAtMillis(b);
    return direction === "oldest" ? diff : -diff;
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
  const detailHref = `order-detail.html?id=${encodeURIComponent(order.orderId)}`;

  return `
    <article class="card card-body order-card compact-order-link">
      <img class="order-thumb" src="${placeholderImage(order.productName || "訂單")}" alt="${escapeHtml(order.productName || "商品")}">
      <div class="order-card-main">
        <div class="order-card-title">
          <h3>${escapeHtml(order.productName || "-")}</h3>
          ${statusBadge(order.status)}
        </div>
        <p class="meta">訂單 ${escapeHtml(order.orderId || "-")} · ${Number(order.quantity || 0)} 份 · ${money(order.totalAmount)}</p>
        <p class="meta">下單 ${orderDateText(order)}</p>
        <p class="meta">取貨 ${dateText(order.pickupTime)} · ${escapeHtml(order.pickupLocation || "-")}</p>
      </div>
      <a class="btn secondary inline" href="${detailHref}">查看詳細</a>
    </article>
  `;
}

function historyOrderCompactCard(order) {
  const detailHref = `order-detail.html?id=${encodeURIComponent(order.orderId)}`;
  return `
    <article class="card card-body compact-order compact-order-link">
      <a class="compact-order-main" href="${detailHref}">
        <h3>${order.productName}</h3>
        <p class="meta">${orderDateText(order)} · ${order.quantity} 份 · ${money(order.totalAmount)}</p>
      </a>
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
      console.error("Login failed", error);
      alert(`登入失敗：${error.code || error.message || "請確認 Email 與密碼。"}`);
    }
  });
}

async function allProducts() {
  const snap = await getDocs(collection(db, "products"));
  if (await syncExpiredProducts(snap.docs)) {
    const freshSnap = await getDocs(collection(db, "products"));
    return freshSnap.docs.map(item => normalizeProduct(item.id, item.data())).sort(sortByCreatedDesc);
  }
  return snap.docs.map(item => normalizeProduct(item.id, item.data())).sort(sortByCreatedDesc);
}

async function syncExpiredProducts(productDocs) {
  const now = new Date();
  const updates = productDocs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(product => product.isActive !== false && ((product.saleEnd && new Date(product.saleEnd) < now) || (product.deadline && new Date(product.deadline) < now)))
    .map(product => updateDoc(doc(db, "products", product.id), { isActive: false, updatedAt: serverTimestamp() }));
  if (!updates.length) return 0;
  await Promise.allSettled(updates);
  return updates.length;
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
  return toDate(order.createdAt)?.getTime() || 0;
}

function orderDateText(order) {
  return dateText(order.createdAt);
}

async function initDashboard() {
  requireAdmin(async () => {
    const [products, orders] = await Promise.all([allProducts(), allOrders()]);
    const todayOrders = orders.filter(order => isToday(order.createdAt));
    const todayRevenue = todayOrders
      .filter(order => order.status !== "已取消")
      .reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
    $("#totalProducts").textContent = products.length;
    $("#totalOrders").textContent = orders.length;
    $("#todayOrders").textContent = todayOrders.length;
    $("#todayRevenue").textContent = money(todayRevenue);
    $("#pickupOrders").textContent = orders.filter(order => order.status === "可取貨").length;
    $("#recentOrdersList").innerHTML = sortOrders(orders, "latest").slice(0, 5).map(dashboardOrderItem).join("") || `<div class="empty">尚無訂單</div>`;
    $("#dashboardHotProducts").innerHTML = sortProducts(products, "popular").slice(0, 3).map(dashboardProductItem).join("") || `<div class="empty">尚無商品排行</div>`;
    const lowStockProducts = products
      .filter(product => product.isActive !== false && !isProductUnlimited(product))
      .filter(product => productRemainingCount(product) <= 5)
      .sort((a, b) => productRemainingCount(a) - productRemainingCount(b));
    $("#lowStockProducts").innerHTML = lowStockProducts.length
      ? lowStockProducts.map(dashboardStockItem).join("")
      : `<div class="empty">目前沒有庫存不足商品</div>`;
  });
}

function dashboardOrderItem(order) {
  return `
    <a class="dashboard-list-item" href="order-detail.html?id=${encodeURIComponent(order.orderId)}&admin=1">
      <div>
        <strong>${escapeHtml(order.orderId || "-")}</strong>
        <p class="meta">${escapeHtml(order.customerName || "-")} · ${escapeHtml(order.productName || "-")}</p>
      </div>
      ${statusBadge(order.status)}
    </a>
  `;
}

function dashboardProductItem(product, index) {
  return `
    <a class="dashboard-list-item" href="admin-products.html">
      <div>
        <strong>第 ${index + 1} 名 ${escapeHtml(product.name || "-")}</strong>
        <p class="meta">已售 ${Number(product.soldCount || 0)} · ${money(product.price)}</p>
      </div>
      <span class="pill">${escapeHtml(product.category || "其他")}</span>
    </a>
  `;
}

function dashboardStockItem(product) {
  return `
    <a class="dashboard-list-item" href="admin-products.html">
      <div>
        <strong>${escapeHtml(product.name || "-")}</strong>
        <p class="meta">${escapeHtml(product.spec || "無規格")} · 限量 ${Number(product.stockLimit || 0)}</p>
      </div>
      <span class="status status-red">剩 ${productRemainingCount(product)}</span>
    </a>
  `;
}

function productCategories(products = [], product = {}) {
  return [...new Set(["其他", ...products.map(item => item.category || "其他"), product.category || "其他"].filter(Boolean))];
}

function categoryDocId(category) {
  return encodeURIComponent(category || "其他");
}

async function saveProductCategory(category) {
  const name = category || "其他";
  await setDoc(doc(db, "productCategories", categoryDocId(name)), { name, updatedAt: serverTimestamp() }, { merge: true });
}

function productForm(product = {}, categories = []) {
  const selectedCategory = product.category || "其他";
  return `
    <form class="form" id="productForm">
      <input type="hidden" name="id" value="${product.id || ""}">
      <div class="field"><label>商品名稱</label><input name="name" value="${escapeHtml(product.name || "")}" required></div>
      <div class="field"><label>價格</label><input name="price" type="number" min="0" value="${product.price || ""}" required></div>
      <div class="field category-field">
        <label>分類標籤</label>
        <select name="category">${categories.map(category => `<option value="${escapeHtml(category)}" ${category === selectedCategory ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}</select>
        <input name="newCategory" placeholder="新增標籤，例如：零食">
      </div>
      <div class="field"><label>規格</label><input name="spec" value="${escapeHtml(product.spec || "")}" required></div>
      <div class="field"><label>描述</label><textarea name="description">${escapeHtml(product.description || "")}</textarea></div>
      <div class="field"><label>商品圖片（可上傳多張）</label><input name="images" type="file" accept="image/*" multiple></div>
      ${product.imageUrls?.length ? `<div class="field"><label>目前圖片</label><div class="form-image-grid">${product.imageUrls.map((url, index) => `<img class="form-image-preview" src="${url}" alt="${escapeHtml(product.name || "商品圖片")} ${index + 1}">`).join("")}</div></div>` : ""}
      <div class="field"><label>截單時間</label><input name="deadline" type="datetime-local" value="${toLocalInput(product.deadline)}" required></div>
      <div class="field"><label>取貨時間</label><input name="pickupTime" type="datetime-local" value="${toLocalInput(product.pickupTime)}" required></div>
      <div class="field"><label>取貨地點</label><input name="pickupLocation" value="${escapeHtml(product.pickupLocation || "")}" required></div>
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

async function uploadProductImages(files) {
  const imageFiles = [...files].filter(file => file?.size);
  return Promise.all(imageFiles.map(uploadProductImage));
}

function compressImageToDataUrl(file, maxSize = 720, quality = 0.68) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resizeDataUrl(reader.result, maxSize, quality).then(resolve).catch(reject);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resizeDataUrl(dataUrl, maxSize = 360, quality = 0.62) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(maxSize / image.width, maxSize / image.height, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function productThumbnailUrl(imageUrl) {
  if (!imageUrl) return "";
  try {
    return imageUrl.startsWith("data:image") ? await resizeDataUrl(imageUrl, 360, 0.62) : imageUrl;
  } catch (error) {
    return imageUrl;
  }
}

async function initAdminProducts() {
  requireAdmin(async () => {
    const modal = $("#productModal");
    const panel = $("#productModalPanel");
    let currentProducts = [];

    const deactivateExpiredProducts = async products => {
      const expiredProducts = products.filter(product => product.isActive !== false && isProductDeadlinePassed(product));
      await Promise.all(expiredProducts.map(product => updateDoc(doc(db, "products", product.id), { isActive: false, updatedAt: serverTimestamp() })));
      return expiredProducts.length;
    };

    const optimizeProductImages = async products => {
      const targets = products.filter(product => product.id && product.imageUrls?.length && (product.hasEmbeddedImages || product.imageStorageVersion !== 2));
      await Promise.allSettled([...new Set(products.map(product => product.category || "其他"))].map(saveProductCategory));
      await Promise.allSettled(targets.map(async product => {
        const imageUrls = product.imageUrls.filter(Boolean);
        if (!imageUrls.length) return;
        const thumbnailUrl = await productThumbnailUrl(imageUrls[0]);
        await Promise.all([
          setDoc(doc(db, "productImages", product.id), { productId: product.id, imageUrls, updatedAt: serverTimestamp() }, { merge: true }),
          updateDoc(doc(db, "products", product.id), {
            imageUrl: thumbnailUrl,
            imageUrls: deleteField(),
            imageStorageVersion: 2,
            updatedAt: serverTimestamp()
          })
        ]);
      }));
      return targets.length;
    };

    const render = async () => {
      currentProducts = await allProducts();
      if (await deactivateExpiredProducts(currentProducts)) currentProducts = await allProducts();
      if (await optimizeProductImages(currentProducts)) currentProducts = await allProducts();
      currentProducts = currentProducts.sort((a, b) => Number(b.isActive !== false) - Number(a.isActive !== false));
      $("#productsTable").innerHTML = currentProducts.map(product => `
        <tr>
          <td><img class="table-thumb" src="${productMainImage(product)}" alt="${escapeHtml(product.name || "商品")}"></td>
          <td><strong>${escapeHtml(product.name)}</strong><br><span class="meta">${escapeHtml(product.spec || "無規格")}</span></td>
          <td><span class="pill">${escapeHtml(product.category || "其他")}</span></td>
          <td>${money(product.price)}</td>
          <td>${product.soldCount || 0} / ${isProductUnlimited(product) ? "不限量" : product.stockLimit || 0}</td>
          <td>${dateText(product.createdAt)}</td>
          <td>${dateText(product.updatedAt)}</td>
          <td><span class="status ${product.isActive !== false ? "status-green" : "status-gray"}">${product.isActive !== false ? "上架" : "下架"}</span></td>
          <td>
            <button class="btn secondary inline editProduct" data-id="${product.id}">編輯</button>
            <button class="btn danger inline deleteProduct" data-id="${product.id}">刪除</button>
          </td>
        </tr>
      `).join("") || `<tr><td colspan="9" class="empty">尚無商品</td></tr>`;

      $$(".editProduct").forEach(button => button.addEventListener("click", async () => {
        const product = currentProducts.find(item => item.id === button.dataset.id);
        await openProductModal(product);
      }));
      $$(".deleteProduct").forEach(button => button.addEventListener("click", async () => {
        if (confirm("確認刪除此商品？")) {
          await Promise.all([
            deleteDoc(doc(db, "products", button.dataset.id)),
            deleteDoc(doc(db, "productImages", button.dataset.id))
          ]);
          await render();
        }
      }));
    };

    const openProductModal = async product => {
      product = product ? normalizeProduct(product.id || "", product) : {};
      await loadProductImages(product);
      panel.innerHTML = `<button class="modal-close" id="closeProductModal" type="button" aria-label="關閉">×</button><h2>${product?.id ? "編輯商品" : "新增商品"}</h2>${productForm(product, productCategories(currentProducts, product))}`;
      modal.classList.add("open");
      $("#closeProductModal").addEventListener("click", () => modal.classList.remove("open"), { once: true });
      $("#productForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const id = form.get("id") || doc(collection(db, "products")).id;
        const uploadedImageUrls = await uploadProductImages(form.getAll("images"));
        const imageUrls = uploadedImageUrls.length ? uploadedImageUrls : product?.imageUrls || [];
        const thumbnailUrl = await productThumbnailUrl(imageUrls[0]);
        const category = form.get("newCategory").trim() || form.get("category").trim() || "其他";
        const stockLimitValue = form.get("stockLimit");
        const stockLimit = stockLimitValue ? Number(stockLimitValue) : 0;
        const stockUnlimited = !stockLimitValue;
        const payload = {
          id,
          name: form.get("name").trim(),
          price: Number(form.get("price")),
          category,
          spec: form.get("spec").trim(),
          description: form.get("description") || "",
          deadline: new Date(form.get("deadline")).toISOString(),
          pickupTime: new Date(form.get("pickupTime")).toISOString(),
          pickupLocation: form.get("pickupLocation").trim(),
          stockUnlimited,
          stockLimit,
          saleStart: form.get("saleStart") ? new Date(form.get("saleStart")).toISOString() : "",
          saleEnd: form.get("saleEnd") ? new Date(form.get("saleEnd")).toISOString() : "",
          soldCount: Number(product?.soldCount || 0),
          isActive: form.get("isActive") === "true",
          imageStorageVersion: 2,
          updatedAt: serverTimestamp()
        };
        payload.imageUrl = thumbnailUrl || product?.imageUrl || "";
        payload.imageUrls = deleteField();
        if (!product?.id) payload.createdAt = serverTimestamp();
        await Promise.all([
          setDoc(doc(db, "products", id), payload, { merge: true }),
          setDoc(doc(db, "productImages", id), { productId: id, imageUrls, updatedAt: serverTimestamp() }, { merge: true }),
          saveProductCategory(category)
        ]);
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
      <div class="field"><label>公告內容</label><textarea name="content" required>${escapeHtml(announcement.content || announcement.title || "")}</textarea></div>
      <div class="field"><label>是否顯示</label><select name="isActive"><option value="true" ${announcement.isActive !== false ? "selected" : ""}>上架</option><option value="false" ${announcement.isActive === false ? "selected" : ""}>下架</option></select></div>
      <div class="schedule-preview">
        <div class="field"><label>預約發布</label><input type="datetime-local" disabled><span class="meta">預留 UI，尚未啟用排程</span></div>
        <div class="field"><label>預約下架</label><input type="datetime-local" disabled><span class="meta">預留 UI，尚未啟用排程</span></div>
      </div>
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
            <h3>公告</h3>
            <div class="pill-row">
              <span class="status ${announcement.isActive ? "status-green" : "status-gray"}">${announcement.isActive ? "上架" : "下架"}</span>
            </div>
          </div>
          <p>${escapeHtml(announcement.content || announcement.title || "")}</p>
          <div class="meta-grid">
            <span>發布時間：${dateText(announcement.createdAt)}</span>
            <span>更新時間：${dateText(announcement.updatedAt)}</span>
          </div>
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
      panel.innerHTML = `<button class="modal-close" id="closeAnnouncementModal" type="button" aria-label="關閉">×</button><h2>${announcement?.id ? "編輯公告" : "新增公告"}</h2>${announcementForm(announcement)}`;
      modal.classList.add("open");
      $("#closeAnnouncementModal").addEventListener("click", () => modal.classList.remove("open"), { once: true });
      $("#announcementForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const id = form.get("id") || doc(collection(db, "announcements")).id;
        const payload = {
          title: "",
          content: form.get("content").trim(),
          type: "",
          isActive: form.get("isActive") === "true",
          pinned: false,
          updatedAt: serverTimestamp()
        };
        if (!announcement?.id) payload.createdAt = serverTimestamp();
        if (payload.isActive) {
          const activeSnap = await getDocs(query(collection(db, "announcements"), where("isActive", "==", true)));
          await Promise.all(activeSnap.docs
            .filter(item => item.id !== id)
            .map(item => updateDoc(doc(db, "announcements", item.id), { isActive: false, pinned: false, updatedAt: serverTimestamp() })));
        }
        await setDoc(doc(db, "announcements", id), payload, { merge: true });
        modal.classList.remove("open");
        await render();
      });
    };

    $("#newAnnouncementBtn").addEventListener("click", () => openAnnouncementModal());
    await render();
  });
}

function orderRow(order) {
  return `
    <tr class="${order.cancelRequested ? "highlight-row" : ""}">
      <td>${stackedDateText(order.createdAt)}</td>
      <td><a href="order-detail.html?id=${encodeURIComponent(order.orderId)}&admin=1"><strong>${escapeHtml(order.orderId)}</strong></a></td>
      <td>${escapeHtml(order.customerName || "-")}<br><span class="meta">${escapeHtml(order.phone || "-")}</span>${order.cancelRequested ? `<br><span class="status status-orange">取消申請</span>` : ""}</td>
      <td>${escapeHtml(order.productName || "-")}${order.adminNote ? `<br><span class="meta">內部備註：${escapeHtml(order.adminNote)}</span>` : ""}</td>
      <td>${order.quantity}</td>
      <td>${money(order.totalAmount)}</td>
      <td>${statusBadge(order.status)}</td>
    </tr>
  `;
}

async function initAdminOrders() {
  requireAdmin(async () => {
    let orders = await allOrders();
    await Promise.allSettled(orders.map(syncPublicOrder));
    let textFilter = "";
    let categoryFilter = "";
    let statusFilter = "";
    let orderSort = "latest";

    const filterOrders = () => {
      const list = orders.filter(order => {
        const matchesText = !textFilter || [order.orderId, order.customerName, order.phone, order.productName].some(value => String(value || "").toLowerCase().includes(textFilter));
        const matchesCategory = !categoryFilter || order.productName === categoryFilter;
        const matchesStatus = !statusFilter || order.status === statusFilter;
        return matchesText && matchesCategory && matchesStatus;
      });
      return sortOrders(list, orderSort);
    };

    const categories = [...new Set(orders.map(order => order.productName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    $("#orderCategoryFilter").innerHTML = `<option value="">全部品項</option>${categories.map(name => `<option value="${name}">${name}</option>`).join("")}`;

    const render = list => {
      $("#ordersTable").innerHTML = list.map(orderRow).join("") || `<tr><td colspan="7" class="empty">查無訂單</td></tr>`;
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
    $("#adminOrderSort").addEventListener("change", event => {
      orderSort = event.target.value;
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
        await Promise.all(targetOrders.map(async order => {
          await updateDoc(doc(db, "orders", order.orderId), {
            status: "可取貨",
            updatedAt: serverTimestamp()
          });
          await syncPublicOrder({ ...order, status: "可取貨" });
        }));
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
  const updatedOrder = {
    ...order,
    ...payload,
    customerId: payload.phone,
    totalAmount: Number(order.price || 0) * newQuantity
  };
  await syncPublicOrder(updatedOrder);
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
  await syncPublicOrder({ ...order, status: "已取消", ...extraPayload });
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
      const order = await findOrderById(orderId);
      if (order) await syncPublicOrder({ ...order, status: "已取貨" });
      $$(".confirmPickup").filter(item => item.dataset.id === orderId).forEach(item => item.closest(".card")?.remove());
      const readyCount = $$("#readyPickupList .confirmPickup").length;
      $("#readyPickupCount").textContent = `${readyCount} 筆`;
      if (!readyCount) $("#readyPickupList").innerHTML = `<div class="empty card">查無訂單</div>`;
    });
  });
}

function isToday(value) {
  const date = toDate(value);
  if (!date) return false;
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
  const reply = wishAdminReply(wish);
  return `
    <article class="card product-card wish-card">
      <img src="${wish.imageUrl || placeholderImage(wish.title || "許願")}" alt="${escapeHtml(wish.title)}">
      <div class="product-card-body">
        <div class="section-head">
          <h3>${admin ? `<button class="link-button wishDetailBtn" data-id="${wish.id}">${escapeHtml(wish.title)}</button>` : escapeHtml(wish.title)}</h3>
          <span class="status status-orange">+1 ${Number(wish.votes || 0)}</span>
        </div>
        <p class="meta">${escapeHtml(wish.description || "沒有補充說明")}</p>
        <div class="wish-progress">
          ${wishProgressBadges(wish)}
          ${admin ? `${wish.isActive === false ? `<span class="status status-gray">已下架</span>` : `<span class="status status-green">顯示中</span>`}` : ""}
        </div>
        ${reply ? `<div class="admin-reply"><strong>管理員回覆</strong><p>${escapeHtml(reply)}</p></div>` : ""}
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

function wishAdminReply(wish) {
  return wish.adminReply || wish.reply || wish.adminResponse || "";
}

function wishIsAccepted(wish) {
  return wish.isAccepted === true || wish.accepted === true || /採納/.test(wish.status || "");
}

function wishIsOpened(wish) {
  return wish.isOpened === true || wish.opened === true || Boolean(wish.productId || wish.groupProductId) || /開團/.test(wish.status || "");
}

function wishProgressBadges(wish) {
  const accepted = wishIsAccepted(wish);
  const opened = wishIsOpened(wish);
  return `
    <span class="status ${accepted ? "status-green" : "status-gray"}">${accepted ? "已採納" : "待評估"}</span>
    <span class="status ${opened ? "status-blue" : "status-gray"}">${opened ? "已開團" : "未開團"}</span>
  `;
}

function wishDetail(wish) {
  const voters = Array.isArray(wish.voters) ? wish.voters : [];
  const reply = wishAdminReply(wish);
  return `
    <button class="modal-close" id="closeWishDetailModal" type="button" aria-label="關閉">×</button>
    <div class="section-head">
      <h2>${escapeHtml(wish.title)}</h2>
      <span class="status status-orange">+1 ${Number(wish.votes || 0)}</span>
    </div>
    <div class="wish-progress">${wishProgressBadges(wish)}</div>
    <div class="info-list">
      <div class="info-row"><span>說明</span><strong>${escapeHtml(wish.description || "-")}</strong></div>
      <div class="info-row"><span>許願人</span><strong>${escapeHtml(wish.customerName || "-")}</strong></div>
      <div class="info-row"><span>許願人手機</span><strong>${escapeHtml(wish.phone || "-")}</strong></div>
      <div class="info-row"><span>建立時間</span><strong>${orderDateText(wish)}</strong></div>
      <div class="info-row"><span>狀態</span><strong>${wish.isActive === false ? "已下架" : "顯示中"}</strong></div>
      ${reply ? `<div class="info-row"><span>管理員回覆</span><strong>${escapeHtml(reply)}</strong></div>` : ""}
    </div>
    <h3 style="margin-top:18px">+1 手機號碼</h3>
    <div class="pill-row">
      ${voters.length ? voters.map(phone => `<span class="pill">${escapeHtml(phone)}</span>`).join("") : `<span class="meta">尚無投票紀錄</span>`}
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
