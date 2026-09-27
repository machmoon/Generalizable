import React from 'react'

import './ReportScreenItem.css';

function ReportScreenItem({ tissue, crossSectionArea, meanHU }) {
  const isInvalidVolume = crossSectionArea === 999999 || crossSectionArea === 'NA';
  const isInvalidHU = meanHU === 999999 || meanHU === 'NA';

  return (
    <div className="ReportScreenItem">
      <div>{tissue}</div>
      <div>{isInvalidVolume ? 'NA' : `${crossSectionArea} cm³`}</div>
      <div>{isInvalidHU ? 'NA' : meanHU}</div>
    </div>
  );
}



export default ReportScreenItem