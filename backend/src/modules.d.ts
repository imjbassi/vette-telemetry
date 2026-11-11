// Wrangler bundles *.html as plain text (see [[rules]] in wrangler.toml).
declare module "*.html" {
  const content: string;
  export default content;
}
