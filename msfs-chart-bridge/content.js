browser.runtime.onMessage.addListener(async message => {
  if (!message || message.type !== "MSFS_PLANNER_FETCH_JSON") {
    return undefined;
  }

  try {
    const response = await fetch(message.url, {
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
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 180);
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
  } catch (error) {
    throw new Error(error.message || "MSFS Planner request failed.");
  }
});
