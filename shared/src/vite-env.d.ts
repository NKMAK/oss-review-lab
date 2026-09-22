// fixturesのJSONLを、Viteの ?raw importで文字列として読むための宣言(テスト専用)。
declare module "*?raw" {
  const content: string;
  export default content;
}
