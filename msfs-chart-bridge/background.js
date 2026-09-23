const pendingCaptures = new Map();

function isPlannerChartUrl(url) {
  return (
    typeof url === "string" &&
    url.startsWith("https://foxtrotatlasprod.blob.core.windows.net/") &&
    /\/charts\/chart-files\//i.test(url) &&
    /\.(png)(?:\?|$)/i.test(url)
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
          "Firefox could not attach the chart response filter: " +
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

      // Always pass the bytes through so Planner's image still loads normally.
      filter.write(event.data);
    };

    filter.onstop = async () => {
      try {
        const output = new Uint8Array(totalBytes);
        let offset = 0;

        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }

        if (!totalBytes) {
          throw new Error(
            "Firefox received a 0-byte MSFS chart response. Retrying with a cache-busting image request may be required."
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
          "Firefox failed while reading the MSFS chart image response."
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
    types: ["image"]
  },
  ["blocking"]
);

browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== "capturePlannerImage") {
    return undefined;
  }

  const { imageUrl, tabId } = message;

  if (
    typeof imageUrl !== "string" ||
    !imageUrl.startsWith(
      "https://foxtrotatlasprod.blob.core.windows.net/"
    )
  ) {
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
    const cacheBuster =
      "__flight_app_chart_bridge=" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2);

    const requestUrl =
      imageUrl +
      (imageUrl.includes("?") ? "&" : "?") +
      cacheBuster;

    const timeout = setTimeout(() => {
      pendingCaptures.delete(requestUrl);
      reject(
        new Error(
          "Timed out waiting for the MSFS Planner chart image."
        )
      );
    }, 30000);

    pendingCaptures.set(requestUrl, {
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

    browser.scripting.executeScript({
      target: { tabId },
      func: async (requestUrl) => {
        const existing = document.querySelector(
          'img[data-flight-app-chart-bridge="' +
          CSS.escape(requestUrl) +
          '"]'
        );

        if (existing) {
          existing.remove();
        }

        await new Promise((resolve, reject) => {
          const image = document.createElement("img");

          image.dataset.flightAppChartBridge = requestUrl;
          image.alt = "";
          image.style.position = "fixed";
          image.style.width = "1px";
          image.style.height = "1px";
          image.style.opacity = "0";
          image.style.pointerEvents = "none";
          image.style.left = "-10000px";
          image.style.top = "-10000px";

          image.onload = () => {
            image.remove();
            resolve();
          };

          image.onerror = () => {
            image.remove();
            reject(
              new Error(
                "The MSFS Planner page could not load the chart image."
              )
            );
          };

          document.documentElement.appendChild(image);
          image.src = requestUrl;
        });
      },
      args: [requestUrl]
    }).catch(error => {
      const current = pendingCaptures.get(requestUrl);
      if (!current) return;

      pendingCaptures.delete(requestUrl);
      clearTimeout(requestTimeout);
      reject(
        new Error(
          "Could not trigger the Planner image request: " +
          (error?.message || error)
        )
      );
    });
  });
});
