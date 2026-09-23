const pendingCapture = {
  active: false,
  expectedPath: null,
  timeout: null,
  resolve: null,
  reject: null
};

function isPlannerChartUrl(url) {
  return (
    typeof url === "string" &&
    url.startsWith("https://foxtrotatlasprod.blob.core.windows.net/") &&
    /\/charts\/chart-files\//i.test(url) &&
    /\.png(?:\?|$)/i.test(url)
  );
}

function finishCaptureError(error) {
  if (!pendingCapture.active) return;

  const reject = pendingCapture.reject;

  clearTimeout(pendingCapture.timeout);
  pendingCapture.active = false;
  pendingCapture.expectedPath = null;
  pendingCapture.resolve = null;
  pendingCapture.reject = null;
  pendingCapture.timeout = null;

  reject?.(error);
}

/*
 * Keep the message listener registered before the webRequest listener.
 * This means the popup can always ping the background context and gives
 * us a useful error instead of Firefox's generic "Receiving end does not
 * exist" message if a network API is unavailable.
 */
browser.runtime.onMessage.addListener(message => {
  if (message?.type === "bridgePing") {
    return Promise.resolve({
      ok: true,
      captureApi:
        typeof browser.webRequest?.filterResponseData === "function"
    });
  }

  if (message?.type !== "capturePlannerImage") {
    return undefined;
  }

  if (pendingCapture.active) {
    return Promise.reject(
      new Error("Another MSFS chart capture is already waiting.")
    );
  }

  return new Promise((resolve, reject) => {
    pendingCapture.active = true;
    pendingCapture.expectedPath = message.imageUrl || null;
    pendingCapture.resolve = resolve;
    pendingCapture.reject = reject;

    pendingCapture.timeout = setTimeout(() => {
      finishCaptureError(
        new Error(
          "No real MSFS chart image request was observed within 30 seconds. " +
          "The chart must be opened/rendered in the MSFS Planner tab so Planner itself makes the authorized Azure request."
        )
      );
    }, 30000);
  });
});

/*
 * IMPORTANT:
 * responseHeaders is NOT a valid extraInfoSpec for onBeforeRequest.
 * Using it here can make Firefox reject the listener during background
 * startup, which then leaves the popup with:
 * "Receiving end does not exist."
 *
 * We therefore attach the response filter in onBeforeRequest with no
 * extraInfoSpec. Content type is inferred as PNG later.
 */
browser.webRequest.onBeforeRequest.addListener(
  details => {
    if (!pendingCapture.active || !isPlannerChartUrl(details.url)) {
      return {};
    }

    const resolve = pendingCapture.resolve;
    const reject = pendingCapture.reject;

    clearTimeout(pendingCapture.timeout);
    pendingCapture.active = false;
    pendingCapture.expectedPath = null;
    pendingCapture.resolve = null;
    pendingCapture.reject = null;
    pendingCapture.timeout = null;

    let filter;

    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (error) {
      reject?.(
        new Error(
          "Firefox could not attach to the real MSFS chart response: " +
          (error?.message || error)
        )
      );
      return {};
    }

    const chunks = [];
    let totalBytes = 0;

    filter.ondata = event => {
      const chunk = new Uint8Array(event.data);
      chunks.push(chunk);
      totalBytes += chunk.byteLength;

      // Always pass the bytes through so Planner itself continues to work.
      filter.write(event.data);
    };

    filter.onstop = () => {
      try {
        if (!totalBytes) {
          throw new Error(
            "The real MSFS chart response was intercepted, but Firefox supplied 0 bytes."
          );
        }

        const output = new Uint8Array(totalBytes);
        let offset = 0;

        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }

        resolve?.({
          buffer: output.buffer,
          contentType: "image/png",
          size: totalBytes,
          url: details.url
        });
      } catch (error) {
        reject?.(
          new Error(
            "Could not assemble the real MSFS chart image: " +
            (error?.message || error)
          )
        );
      } finally {
        try {
          filter.disconnect();
        } catch {}
      }
    };

    filter.onerror = () => {
      reject?.(
        new Error(
          "Firefox failed while reading the real MSFS chart response."
        )
      );

      try {
        filter.disconnect();
      } catch {}
    };

    return {};
  },
  {
    urls: [
      "https://foxtrotatlasprod.blob.core.windows.net/*"
    ]
  }
);
