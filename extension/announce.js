// FC-Tracker Web (fc-tracker.com/web) talks to this extension by its id. A copy loaded from the
// .zip has its own id, not the Chrome Web Store's: tell the page which one this is (only the id –
// nothing else is shared here).
document.documentElement.dataset.fctExt = chrome.runtime.id;
