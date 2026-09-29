(() => {
  function install() {
    const tricorder = window.Tricorder;
    if (!tricorder || !tricorder.spatial) return false;

    tricorder.onOrientationMatrix = function onOrientationMatrix(matrix, displayRotation, declinationDegrees) {
      if (!Array.isArray(matrix) || matrix.length !== 9) return;
      tricorder.spatial.setPose({
        rotationMatrix: matrix,
        displayRotation: Number(displayRotation) || 0,
        declinationDegrees: Number(declinationDegrees) || 0
      });
    };
    return true;
  }

  if (!install()) {
    window.setTimeout(install, 0);
  }
})();