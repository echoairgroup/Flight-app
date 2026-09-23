const API = "https://echo-msfs-charts.onrender.com";
const PLANNER = "https://planner.flightsimulator.com";
const MAP = {
  IAC: "APPROACH",
  SID: "SID",
  SIDPT: "SID",
  STAR: "STAR",
  AOI: "AIRPORT",
  AGC: "AIRPORT",
  APC: "AIRPORT",
  AFC: "AIRPORT",
  MRC: "ENROUTE"
};

let charts = [];
const $ = id => document.getElementById(id);

function log(message) {
  const el = $("log");
  el.textContent += message + "\n";
  el.scrollTop = el.scrollHeight;
}

function setStatus(message, type = "muted") {
  $("status").textContent = message;
  $("status").className = "small " + type;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;",
    "'":"&#39;"
  }[char]));
}

async function plannerJSON(url) {
  const tabs = await browser.tabs.query({
    url: ["https://planner.flightsimulator.com/*"],
    active: true,
    currentWindow: true
  });

  if (!tabs.length) {
    throw new Error("Open planner.flightsimulator.com in a Firefox tab and make sure you are logged in.");
  }

  const tabId = tabs[0].id;

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: async (requestUrl) => {
        const response = await fetch(requestUrl, {
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*"
          },
          cache: "no-store"
        });

        const text = await response.text();
        let data = null;

        try {
          data = JSON.parse(text);
        } catch {}

        if (!response.ok) {
          throw new Error("MSFS Planner HTTP " + response.status);
        }

        if (!data) {
          const preview = text.replace(/\\s+/g, " ").trim().slice(0, 180);
          if (/<!doctype html|<html/i.test(text)) {
            throw new Error(
              "MSFS Planner returned its web page instead of JSON. Make sure you are logged in."
            );
          }
          throw new Error(
            "MSFS Planner returned invalid JSON" +
            (preview ? " — " + preview : ".")
          );
        }

        return data;
      },
      args: [url]
    });

    if (!results || !results.length) {
      throw new Error("The Planner tab returned no result.");
    }

    if (results[0].error) {
      throw new Error(results[0].error.message || "MSFS Planner request failed.");
    }

    return results[0].result;
  } catch (error) {
    throw new Error(
      error.message ||
      "Could not connect to the MSFS Planner tab."
    );
  }
}

function msfsAirportIdentifier(icao) {
  return "A" + " ".repeat(6) + icao + " ";
}

function renderCharts() {
  $("count").textContent = charts.length + " charts found.";
  $("list").innerHTML = charts.length
    ? charts.map((chart, index) => {
        const name =
          chart.meta?.name ||
          chart.meta?.chartName ||
          chart.category + " chart";

        return (
          '<div class="item">' +
            '<label>' +
              '<input type="checkbox" data-index="' + index + '" checked>' +
              '<span>' +
                '<div class="name">' + esc(name) + '</div>' +
                '<div class="meta">' +
                  esc(chart.category) + " · " +
                  esc(chart.meta?.guid || "") +
                '</div>' +
              '</span>' +
            '</label>' +
          '</div>'
        );
      }).join("")
    : '<div class="small muted">No charts found.</div>';
}

async function loadCharts() {
  const icao = $("icao").value.trim().toUpperCase();
  const provider = $("provider").value;

  if (!/^[A-Z]{4}$/.test(icao)) {
    setStatus("Enter a valid 4-letter ICAO code.", "err");
    return;
  }

  $("load").disabled = true;
  setStatus("Loading the authenticated MSFS Planner chart index…");
  log("Loading " + icao + " / " + provider + " through your browser session…");

  try {
    const encodedAirport = encodeURIComponent(msfsAirportIdentifier(icao));
    const candidates = [
      PLANNER + "/api/v1/charts/index/" + encodedAirport +
        "?provider=" + encodeURIComponent(provider),
      PLANNER + "/api/v1/charts/" + encodedAirport +
        "?provider=" + encodeURIComponent(provider),
      PLANNER + "/api/v1/charts/index/A/" + encodeURIComponent(icao) +
        "?provider=" + encodeURIComponent(provider)
    ];

    let data = null;
    let lastError = null;

    for (const url of candidates) {
      try {
        data = await plannerJSON(url);
        if (data?.charts) break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!data?.charts) {
      throw lastError || new Error("Planner response did not contain charts.");
    }

    charts = [];

    for (const [category, items] of Object.entries(data.charts)) {
      if (!Array.isArray(items)) continue;
      for (const meta of items) {
        if (meta?.guid) charts.push({ category, meta });
      }
    }

    renderCharts();
    setStatus(
      charts.length + " charts loaded for " + icao + " / " + provider + ".",
      "ok"
    );
    log("SUCCESS: " + charts.length + " charts found.");
  } catch (error) {
    charts = [];
    renderCharts();
    setStatus(error.message, "err");
    log("LOAD FAILED: " + error.message);
  } finally {
    $("load").disabled = false;
  }
}

async function plannerPages(guid) {
  return plannerJSON(
    PLANNER + "/api/v1/charts/pages/" + encodeURIComponent(guid)
  );
}

/*
 * The Planner loads chart PNGs as normal cross-origin image resources.
 * Firefox's webRequest.filterResponseData API lets the extension observe
 * those exact response bytes while still passing them through to Planner.
 *
 * We deliberately do NOT fetch the Azure URL ourselves and we never read
 * or forward the Planner session cookies/tokens.
 */
async function plannerImage(imageUrl, chart, pageIndex = 0) {
  const tabs = await browser.tabs.query({
    url: ["https://planner.flightsimulator.com/*"],
    active: true,
    currentWindow: true
  });

  if (!tabs.length) {
    throw new Error(
      "Open planner.flightsimulator.com in a Firefox tab before importing charts."
    );
  }

  const tabId = tabs[0].id;
  const chartName =
    chart?.meta?.name ||
    chart?.meta?.chartName ||
    chart?.category + " chart";

  /*
   * A page URL returned by /api/v1/charts/pages is an FsChartPageUrl
   * handle, not the actual Azure image URL. We can still reuse a signed
   * request that Planner has already made, which avoids another network
   * round-trip when this exact chart is already open.
   */
  const handlePath = (() => {
    try {
      return new URL(imageUrl).pathname;
    } catch {
      return String(imageUrl || "").split("?")[0];
    }
  })();

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (wantedPath) => {
        const entries = performance.getEntriesByType("resource");

        const candidates = entries
          .map(entry => String(entry.name || ""))
          .filter(url =>
            url.startsWith(
              "https://foxtrotatlasprod.blob.core.windows.net/"
            ) &&
            /\/charts\/chart-files\//i.test(url) &&
            /\.png(?:\?|$)/i.test(url)
          );

        const exact = candidates.find(url => {
          try {
            return new URL(url).pathname === wantedPath;
          } catch {
            return false;
          }
        });

        return exact || null;
      },
      args: [handlePath]
    });

    const found = results?.[0]?.result || null;

    if (found) {
      log("Found an existing signed Planner image request for " + chartName + ".");

      const response = await fetch(found, {
        credentials: "include",
        cache: "no-store"
      });

      if (response.ok) {
        const buffer = await response.arrayBuffer();

        if (buffer.byteLength) {
          log(
            "Downloaded " +
            Math.round(buffer.byteLength / 1024) +
            " KB from Planner's existing chart image."
          );

          return new Blob([buffer], { type: "image/png" });
        }
      }

      log(
        "The existing signed image was no longer usable (HTTP " +
        response.status +
        "). Planner will render the chart again."
      );
    }
  } catch (error) {
    log(
      "Existing signed image lookup failed: " +
      (error?.message || error) +
      ". Continuing with live Planner rendering."
    );
  }

  log(
    "Opening " +
    chartName +
    (pageIndex ? " — Page " + (pageIndex + 1) : "") +
    " in MSFS Planner and capturing its real image request…"
  );

  let result;

  try {
    const ping = await browser.runtime.sendMessage({
      type: "bridgePing"
    });

    if (!ping?.ok) {
      throw new Error(
        "The MSFS Chart Bridge background process is not responding. Reload the extension and try again."
      );
    }

    result = await browser.runtime.sendMessage({
      type: "capturePlannerImage",
      imageUrl,
      tabId,
      chartName,
      category: chart?.category || ""
    });
  } catch (error) {
    throw new Error(
      error?.message ||
      "Firefox could not capture the real MSFS Planner chart image."
    );
  }

  if (!result?.buffer || !result.buffer.byteLength) {
    throw new Error(
      "The real MSFS Planner chart capture returned 0 bytes."
    );
  }

  log(
    "Captured " +
    Math.round(result.buffer.byteLength / 1024) +
    " KB from the real Planner image request."
  );

  return new Blob(
    [result.buffer],
    { type: "image/png" }
  );
}

async function getAirportName(icao) {
  try {
    const response = await fetch(
      API + "/api/airports/" + encodeURIComponent(icao),
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) return "";

    const data = await response.json();
    return data?.airport?.name || data?.name || "";
  } catch {
    return "";
  }
}

async function importSelected() {
  const icao = $("icao").value.trim().toUpperCase();
  const provider = $("provider").value;

  const selected = [
    ...document.querySelectorAll("[data-index]:checked")
  ].map(input => Number(input.dataset.index));

  if (!selected.length) {
    setStatus("Select at least one chart.", "err");
    return;
  }

  $("import").disabled = true;
  const airportName = await getAirportName(icao);

  let pagesImported = 0;
  let chartsFailed = 0;

  for (const index of selected) {
    const chart = charts[index];
    const name =
      chart.meta?.name ||
      chart.meta?.chartName ||
      chart.category + " chart";

    try {
      log("Reading pages: " + name);

      const pageData = await plannerPages(chart.meta.guid);
      const pages = pageData?.pages || [];

      if (!pages.length) {
        throw new Error("No chart pages returned.");
      }

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        const imageUrl =
          page?.urls?.light_png ||
          page?.urls?.dark_png;

        if (!imageUrl) {
          throw new Error("Page " + (pageIndex + 1) + " has no PNG URL.");
        }

        const pageName =
          name +
          (pages.length > 1 ? " — Page " + (pageIndex + 1) : "");

        log("Requesting chart image through MSFS Planner: " + pageName);

        /*
         * The signed Azure URL can be used successfully from the user's
         * browser session, but Microsoft/Azure may reject a server-side
         * Render request (for example because the SAS is tied to the
         * originating client). Therefore the browser extension downloads
         * the image bytes itself.
         *
         * The raw image is then uploaded to Flight-app as multipart/form-data.
         * The signed MSFS URL is never sent to or stored by the backend.
         */
        const imageBlob = await plannerImage(imageUrl, chart, pageIndex);

        const formData = new FormData();
        formData.append("airport_icao", icao);
        formData.append("airport_name", airportName);
        formData.append("chart_name", pageName);
        formData.append(
          "chart_type",
          MAP[chart.category] || "AIRPORT"
        );
        formData.append("provider", provider);
        formData.append(
          "validity",
          String(
            chart.meta?.validUntil ||
            chart.meta?.validFrom ||
            ""
          )
        );

        const extension =
          imageBlob.type === "image/jpeg"
            ? "jpg"
            : imageBlob.type === "image/webp"
              ? "webp"
              : "png";

        formData.append(
          "image",
          imageBlob,
          "msfs-" + icao + "-" + chart.meta.guid + "-" + (pageIndex + 1) + "." + extension
        );

        const response = await fetch(
          API + "/api/charts/import-msfs",
          {
            method: "POST",
            headers: {
              Accept: "application/json"
            },
            body: formData
          }
        );

        const responseText = await response.text();
        let data = null;

        try { data = JSON.parse(responseText); } catch {}

        if (!response.ok) {
          throw new Error(
            data?.error ||
            "Flight-app backend HTTP " + response.status
          );
        }

        pagesImported++;
        log("OK: " + pageName);
      }
    } catch (error) {
      chartsFailed++;
      log("FAIL: " + name + " — " + error.message);
    }
  }

  $("import").disabled = false;

  setStatus(
    "Finished: " + pagesImported +
    " pages imported, " + chartsFailed +
    " chart entries failed.",
    chartsFailed ? "err" : "ok"
  );
}

$("icao").addEventListener("input", () => {
  $("icao").value =
    $("icao").value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
});

$("load").addEventListener("click", loadCharts);
$("import").addEventListener("click", importSelected);

$("all").addEventListener("click", () => {
  document.querySelectorAll("[data-index]")
    .forEach(input => input.checked = true);
});

$("none").addEventListener("click", () => {
  document.querySelectorAll("[data-index]")
    .forEach(input => input.checked = false);
});