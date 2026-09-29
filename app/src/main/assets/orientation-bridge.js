(() => {
  function install() {
    const tricorder = window.Tricorder;
    if (!tricorder || !tricorder.radar || !tricorder.radar.world || !tricorder.spatial) return false;

    tricorder.onOrientationMatrix = function onOrientationMatrix(matrix, displayRotation, declinationDegrees) {
      if (!Array.isArray(matrix) || matrix.length !== 9) return;
      tricorder.spatial.setPose({
        rotationMatrix: matrix,
        displayRotation: Number(displayRotation) || 0,
        declinationDegrees: Number(declinationDegrees) || 0
      });

      const heading = tricorder.radar.world.mapHeadingDegrees();
      tricorder.radar.setHeading(heading);
    };
    return true;
  }

  if (!install()) {
    window.setTimeout(install, 0);
  }
})();