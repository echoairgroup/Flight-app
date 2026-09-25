(() => {
  const API = window.FLIGHT_APP_API || "https://echo-msfs-charts.onrender.com";
  const TOKEN_KEY = "flightAppToken";

  function getToken(){ return localStorage.getItem(TOKEN_KEY) || ""; }
  function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Accept")) headers.set("Accept","application/json");
    const token = getToken();
    if (token) headers.set("Authorization", "Bearer " + token);
    const response = await fetch(API + path, {...options, headers});
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(data?.error || ("Request failed (" + response.status + ")"));
      error.status = response.status;
      error.data = data;
      if (response.status === 401) clearToken();
      throw error;
    }
    return data;
  }

  async function me() {
    const token = getToken();
    if (!token) return null;
    try {
      const data = await request("/api/auth/me", {method:"GET"});
      return data.user || null;
    } catch (error) {
      if (error.status === 401) return null;
      throw error;
    }
  }

  function logout(){
    clearToken();
    window.location.href = "login.html";
  }

  async function requireLogin() {
    const user = await me();
    if (!user) {
      const next = encodeURIComponent(location.pathname.split("/").pop() || "index.html");
      location.href = "login.html?next=" + next;
      return null;
    }
    return user;
  }

  async function isAdmin() {
    try { const data = await request("/api/auth/admin", {method:"GET"}); return data?.admin === true; }
    catch { return false; }
  }
  async function requireAdmin() {
    const user = await requireLogin();
    if (!user) return null;
    if (!(await isAdmin())) {
      location.href = "index.html";
      return null;
    }
    return user;
  }
  window.FlightAppAuth = { API, TOKEN_KEY, getToken, clearToken, request, me, logout, requireLogin, isAdmin, requireAdmin };
})();