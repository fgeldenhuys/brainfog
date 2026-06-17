declare module "mustache" {
  const Mustache: {
    parse(template: string): unknown;
    render(template: string, view: unknown): string;
  };
  export default Mustache;
}
