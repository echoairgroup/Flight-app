const pendingCapture = {
  active: false,
  expectedPath: null,
  timeout: null,
  resolve: null,
  reject: null,
  tabId: null
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
  pendingCapture.tabId = null;

  reject?.(error);
}

function finishCaptureSuccess(value) {
  if (!pendingCapture.active) return;

  const resolve = pendingCapture.resolve;

  clearTimeout(pendingCapture.timeout);
  pendingCapture.active = false;
  pendingCapture.expectedPath = null;
  pendingCapture.resolve = null;
  pendingCapture.reject = null;
  pendingCapture.timeout = null;
  pendingCapture.tabId = null;

  resolve?.(value);
}

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

  const tabId = Number(message.tabId);
  const chartName = String(message.chartName || "").trim();
  const category = String(message.category || "").trim();

  if (!Number.isInteger(tabId)) {
    return Promise.reject(new Error("No valid MSFS Planner tab was supplied."));
  }

  return new Promise((resolve, reject) => {
    pendingCapture.active = true;
    pendingCapture.expectedPath = message.imageUrl || null;
    pendingCapture.resolve = resolve;
    pendingCapture.reject = reject;
    pendingCapture.tabId = tabId;

    pendingCapture.timeout = setTimeout(() => {
      finishCaptureError(
        new Error(
          "Planner was opened for the selected chart, but Firefox did not observe the chart image response within 30 seconds."
        )
      );
    }, 30000);

    /*
     * This is the missing half of the old bridge:
     * /pages returns a handle, not a downloadable URL. The Planner UI must
     * actually open the corresponding chart row before Azure serves its
     * signed image request.
     */
    browser.tabs.sendMessage(tabId, {
      type: "openPlannerChart",
      chartName,
      category
    }).then(async result => {
      if (!result?.ok) {
        finishCaptureError(
          new Error("Planner did not confirm that the selected chart was opened.")
        );
        return;
      }

      /*
       * The content script sees the exact signed Azure URL that Planner
       * assigned to the <img>. Use it from the privileged extension context
       * whenever possible. This also handles browser-cache cases where no
       * new network request is emitted after the row is clicked.
       */
      if (result.imageUrl) {
        try {
          const response = await fetch(result.imageUrl, {
            cache: "no-store",
            referrer: "https://planner.flightsimulator.com/",
            referrerPolicy: "strict-origin-when-cross-origin"
          });

          if (response.ok) {
            const buffer = await response.arrayBuffer();

            if (buffer.byteLength) {
              finishCaptureSuccess({
                buffer,
                contentType:
                  response.headers.get("content-type") || "image/png",
                size: buffer.byteLength,
                url: result.imageUrl
              });
              return;
            }
          }
        } catch (error) {
          /*
           * Keep the webRequest path alive. If the chart was freshly
           * requested, its response body may already be on the way and the
           * interceptor below can still supply the bytes.
           */
        }
      }

      /*
       * No direct extension fetch succeeded. Do not reject here: the
       * webRequest response-body interceptor is the fallback for a fresh
       * Planner request.
       */
    }).catch(error => {
      finishCaptureError(
        new Error(
          "Could not drive the MSFS Planner chart list: " +
          (error?.message || error)
        )
      );
    });
  });
});

/*
 * responseHeaders is not valid here. We only need the requestId so Firefox
 * can attach a response-body filter to the real Azure PNG request.
 */
browser.webRequest.onBeforeRequest.addListener(
  details => {
    if (
      !pendingCapture.active ||
      !isPlannerChartUrl(details.url) ||
      Number(details.tabId) !== Number(pendingCapture.tabId) ||
      details.type !== "image"
    ) {
      return {};
    }

    const reject = pendingCapture.reject;

    let filter;

    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (error) {
      finishCaptureError(
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

      try {
        filter.write(event.data);
      } catch (error) {
        finishCaptureError(
          new Error(
            "Firefox could not pass the MSFS chart response through to Planner: " +
            (error?.message || error)
          )
        );
      }
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

        finishCaptureSuccess({
          buffer: output.buffer,
          contentType: "image/png",
          size: totalBytes,
          url: details.url
        });
      } catch (error) {
        finishCaptureError(
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
      const detail = filter.error ? " — " + filter.error : "";
      finishCaptureError(
        new Error(
          "Firefox failed while reading the real MSFS chart response" + detail + "."
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
