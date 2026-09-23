/*
 * Flight-app MSFS Chart Bridge background.
 *
 * The MSFS Planner /pages API returns an FsChartPageUrl handle. The Planner
 * UI resolves that handle into a real signed Azure PNG URL when the chart is
 * opened. We ask the Planner tab to open the chart, receive that signed URL,
 * and then fetch the image from this privileged extension context.
 *
 * No MSFS session token/cookie is read or sent to Flight-app.
 */

browser.runtime.onMessage.addListener(message => {
  if (message?.type === "bridgePing") {
    return Promise.resolve({
      ok: true,
      captureApi: false,
      mode: "planner-rendered-url"
    });
  }

  if (message?.type !== "capturePlannerImage") {
    return undefined;
  }

  const tabId = Number(message.tabId);
  const chartName = String(message.chartName || "").trim();
  const category = String(message.category || "").trim();

  if (!Number.isInteger(tabId)) {
    return Promise.reject(
      new Error("No valid MSFS Planner tab was supplied.")
    );
  }

  return (async () => {
    let rendered;

    try {
      rendered = await browser.tabs.sendMessage(tabId, {
        type: "openPlannerChart",
        chartName,
        category,
        imageUrl: message.imageUrl || ""
      });
    } catch (error) {
      throw new Error(
        "Could not drive the MSFS Planner chart list: " +
        (error?.message || error)
      );
    }

    if (!rendered?.ok || !rendered.imageUrl) {
      throw new Error(
        "MSFS Planner opened the chart, but did not expose the rendered chart image URL."
      );
    }

    const imageUrl = String(rendered.imageUrl);

    if (
      !/^https:\/\/foxtrotatlasprod\.blob\.core\.windows\.net\//i.test(imageUrl) ||
      !/\/charts\/chart-files\//i.test(imageUrl) ||
      !/\.png(?:\?|$)/i.test(imageUrl)
    ) {
      throw new Error(
        "Planner returned an unexpected chart image URL."
      );
    }

    let response;

    try {
      response = await fetch(imageUrl, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrer: "https://planner.flightsimulator.com/",
        referrerPolicy: "strict-origin-when-cross-origin",
        headers: {
          Accept: "image/png,image/*;q=0.9,*/*;q=0.5"
        }
      });
    } catch (error) {
      throw new Error(
        "Firefox could not fetch Planner's signed chart image: " +
        (error?.message || error)
      );
    }

    if (!response.ok) {
      throw new Error(
        "Planner's signed chart image returned HTTP " + response.status + "."
      );
    }

    const contentType =
      response.headers.get("content-type") || "image/png";

    const buffer = await response.arrayBuffer();

    if (!buffer.byteLength) {
      throw new Error(
        "Planner returned an empty chart image."
      );
    }

    return {
      buffer,
      contentType,
      size: buffer.byteLength,
      url: imageUrl
    };
  })();
});
