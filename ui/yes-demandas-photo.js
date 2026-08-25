(function attachYesHotelDemandasPhoto(globalScope) {
  const MAX_PX = 1600;
  const QUALITY = 0.8;
  const MAX_BYTES = 2 * 1024 * 1024;

  function loadImage(file) {
    if (typeof globalScope.createImageBitmap === "function") {
      return globalScope.createImageBitmap(file, { imageOrientation: "from-image" }).catch(
        function () {
          return globalScope.createImageBitmap(file);
        },
      );
    }

    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = function () {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Nao foi possivel ler a imagem."));
      };
      image.src = url;
    });
  }

  async function compressImageFile(file) {
    if (!file) {
      throw new Error("Arquivo de imagem obrigatorio.");
    }

    const mime = String(file.type || "").toLowerCase();
    if (
      (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") &&
      file.size > 0 &&
      file.size <= MAX_BYTES
    ) {
      return file;
    }

    const bitmap = await loadImage(file);
    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    const scale = Math.min(1, MAX_PX / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas indisponivel para compactar a foto.");
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }

    const blob = await new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (result) {
          if (!result) {
            reject(new Error("Falha ao compactar a foto em JPEG."));
            return;
          }
          resolve(result);
        },
        "image/jpeg",
        QUALITY,
      );
    });

    if (blob.size > MAX_BYTES) {
      throw new Error("Foto ainda excede 2 MB apos compactacao. Tire outra foto.");
    }

    return new File([blob], "demanda.jpg", { type: "image/jpeg" });
  }

  globalScope.YesHotelDemandasPhoto = {
    MAX_PX,
    QUALITY,
    MAX_BYTES,
    compressImageFile,
  };
})(window);
