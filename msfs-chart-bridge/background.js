const pendingCaptures = new Map();

function isPlannerChartUrl(url) {
  return (
    typeof url === "string" &&
    url.startsWith("https://foxtrotatlasprod.blob.core.windows.net/") &&
    /\/charts\/chart-files\//i.test(url) &&
    /\.png(?:\?|$)/i.test(url)
  );
}

browser.webRequest.onBeforeRequest.addListener(
  details => {
    if (!isPlannerChartUrl(details.url)) {
      return {};
    }

    const capture = pendingCaptures.get(details.url);
    if (!capture) {
      return {};
    }

    pendingCaptures.delete(details.url);

    let filter;

    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (error) {
      capture.reject(
        new Error(
          "Firefox could not attach the MSFS chart response filter: " +
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

      // Keep the Planner request working normally while we copy the bytes.
      filter.write(event.data);
    };

    filter.onstop = () => {
      try {
        const output = new Uint8Array(totalBytes);
        let offset = 0;

        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }

        if (!totalBytes) {
          throw new Error(
            "Firefox intercepted the MSFS chart request but received 0 bytes."
          );
        }

        capture.resolve({
          buffer: output.buffer,
          contentType: capture.contentType || "image/png",
          size: totalBytes
        });
      } catch (error) {
        capture.reject(
          new Error(
            "Could not assemble the MSFS chart image: " +
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
      capture.reject(
        new Error(
          "Firefox failed while reading the MSFS chart response."
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
    ],
    types: ["image", "xmlhttprequest", "fetch"]
  },
  ["blocking"]
);

browser.runtime.onMessage.addListener(message => {
  if (message?.type !== "capturePlannerImage") {
    return undefined;
  }

  const { imageUrl, tabId } = message;

  if (!isPlannerChartUrl(imageUrl)) {
    return Promise.reject(
      new Error("Invalid MSFS chart image URL.")
    );
  }

  if (!Number.isInteger(tabId)) {
    return Promise.reject(
      new Error("No valid MSFS Planner tab was supplied.")
    );
  }

  if (pendingCaptures.has(imageUrl)) {
    return Promise.reject(
      new Error("This chart image is already being captured.")
    );
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCaptures.delete(imageUrl);
      reject(
        new Error(
          "Timed out waiting for the MSFS Planner chart image request."
        )
      );
    }, 30000);

    pendingCaptures.set(imageUrl, {
      contentType: "image/png",
      resolve: result => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    /*
     * IMPORTANT:
     * Use the exact URL returned by the Planner. Never append a cache-buster
     * or modify the SAS query string. The Planner treats this URL as a handle
     * and its own request path is what successfully authorizes the image.
     *
     * We trigger an opaque no-cors fetch from the Planner page. The page does
     * not get access to the response body, while the extension's webRequest
     * response filter captures the actual bytes.
     */
    browser.scripting.executeScript({
      target: { tabId },
      func: async requestUrl => {
        const response = await fetch(requestUrl, {
          method: "GET",
          mode: "no-cors",
          credentials: "omit",
          cache: "reload",
          referrerPolicy: "strict-origin-when-cross-origin"
        });

        /*
         * An opaque response is expected here. Its body is captured by the
         * extension's webRequest filter, not by the page.
         */
        return {
          type: response.type,
          status: response.status
        };
      },
      args: [imageUrl]
    }).then(() => {
      /*
       * The actual bytes are delivered asynchronously through filter.onstop.
       */
    }).catch(error => {
      const current = pendingCaptures.get(imageUrl);
      if (!current) return;

      pendingCaptures.delete(imageUrl);
      clearTimeout(timeout);

      reject(
        new Error(
          "Could not trigger the MSFS Planner chart request: " +
          (error?.message || error)
        )
      );
    });
  });
});
