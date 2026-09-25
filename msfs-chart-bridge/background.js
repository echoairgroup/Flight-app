browser.runtime.onMessage.addListener(message => {
  if (message?.type === "bridgePing") {
    return Promise.resolve({
      ok: true,
      mode: "planner-rendered-url",
      allFrames: true
    });
  }

  if (message?.type !== "capturePlannerImage") return undefined;

  const tabId = Number(message.tabId);
  const chartName = String(message.chartName || "").trim();
  const category = String(message.category || "").trim();

  if (!Number.isInteger(tabId)) {
    return Promise.reject(new Error("No valid MSFS Planner tab was supplied."));
  }

  return (async () => {
    const request = {
      type: "openPlannerChart",
      chartName,
      category,
      imageUrl: message.imageUrl || ""
    };

    let frames = [{ frameId: 0, url: "" }];

    try {
      if (browser.webNavigation?.getAllFrames) {
        const allFrames = await browser.webNavigation.getAllFrames({ tabId });
        if (Array.isArray(allFrames) && allFrames.length) {
          frames = allFrames
            .map(frame => ({
              frameId: Number(frame.frameId),
              url: String(frame.url || "")
            }))
            .filter(frame => Number.isInteger(frame.frameId));
        }
      }
    } catch (error) {
      console.warn("[Flight-app Chart Bridge] Frame enumeration failed:", error);
    }

    // The actual Planner UI is often deeper than the shell document.
    frames.sort((a, b) => {
      if (a.frameId === 0) return 1;
      if (b.frameId === 0) return -1;
      return b.frameId - a.frameId;
    });

    let lastError = null;
    let rendered = null;

    for (const frame of frames) {
      try {
        const candidate = await browser.tabs.sendMessage(
          tabId,
          request,
          { frameId: frame.frameId }
        );

        if (candidate?.ok && candidate.imageUrl) {
          rendered = candidate;
          break;
        }

        lastError = new Error(
          "Planner frame " + frame.frameId +
          " did not return a rendered chart image."
        );
      } catch (error) {
        lastError = error;
      }
    }

    if (!rendered) {
      const frameSummary = frames
        .map(frame => frame.frameId + (frame.url ? " (" + frame.url + ")" : ""))
        .join(", ");

      throw new Error(
        "Could not drive the MSFS Planner chart list in any frame. " +
        "Frames checked: " + (frameSummary || "0") +
        (lastError?.message ? ". Last error: " + lastError.message : ".")
      );
    }

    const imageUrl = String(rendered.imageUrl);

    if (
      !/^https:\/\/foxtrotatlasprod\.blob\.core\.windows\.net\//i.test(imageUrl) ||
      !/\/charts\/chart-files\//i.test(imageUrl) ||
      !/\.png(?:\?|$)/i.test(imageUrl)
    ) {
      throw new Error("Planner returned an unexpected chart image URL.");
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

    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = await response.arrayBuffer();

    if (!buffer.byteLength) {
      throw new Error("Planner returned an empty chart image.");
    }

    return {
      buffer,
      contentType,
      size: buffer.byteLength,
      url: imageUrl
    };
  })();
});
