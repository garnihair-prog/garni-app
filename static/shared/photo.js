/* GARNI アプリ - 写真アップロード共通ユーティリティ
   画像ファイルをブラウザ側でリサイズ・圧縮してから data URL (base64) に変換する。
   サーバーへの送信量を抑えるため、長辺を最大 MAX_DIM に縮小してJPEG化する。 */
const PHOTO_MAX_DIM = 1000;
const PHOTO_QUALITY = 0.8;

function resizeImageFileToDataUrl(file, maxDim, quality) {
  maxDim = maxDim || PHOTO_MAX_DIM;
  quality = quality || PHOTO_QUALITY;
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      reject(new Error("画像ファイルを選択してください"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
