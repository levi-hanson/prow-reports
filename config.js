// ArcGIS OAuth app (Content -> New item -> Developer credentials -> OAuth credentials).
// Every address the tool is served from must be listed as a Redirect URL on that app:
//   https://levi-hanson.github.io/prow-reports/   (GitHub Pages)
//   https://daxbot-prow-reports.netlify.app/      (old Netlify site)
export const CONFIG = {
  clientId: "r91RUvvTPb9eDgfr",
  portal: "https://novadynamics.maps.arcgis.com",        // org URL (supports org sign-in / SSO)
  redirectUri: location.origin + location.pathname.replace(/[^/]*$/, ""),   // this page's folder, e.g. .../prow-reports/
  defaultSearch: "Results Map",
};
