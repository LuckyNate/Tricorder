(() => {
  function install() {
    const tricorder = window.Tricorder;
    if (!tricorder || !tricorder.spatial) return false;

    tricorder.onOrientationMatrix = function onOrientationMatrix(matrix, displayRotation, declinationDegrees, gravityVector) {
      if (Array.isArray(gravityVector) && gravityVector.length === 3) {
        tricorder.spatial.setGravityVector(gravityVector, Number(displayRotation) || 0);
      }
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