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

        log("Downloading image in Firefox: " + pageName);

        const imageResponse = await fetch(imageUrl, {
          credentials: "include",
          cache: "no-store"
        });

        if (!imageResponse.ok) {
          throw new Error(
            "MSFS chart image returned HTTP " +
            imageResponse.status
          );
        }

        const imageBlob = await imageResponse.blob();

        if (!imageBlob.type.startsWith("image/")) {
          throw new Error(
            "MSFS chart response was not an image (" +
            (imageBlob.type || "unknown") +
            ")."
          );
        }

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
        formData.append(
          "image",
          imageBlob,
          pageName.replace(/[^a-z0-9]+/gi, "_") + ".png"
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