import React from 'react';
import { useEffect, useState } from 'react';
import ReportScreenItem from './ReportScreenItem';
import { APP_CONSTANTS } from '../../helpers/constants';
import './ReportScreen.css';
import { filenameToName } from '../../helpers/util';


function ReportScreen({ sessionKey }) {
  const [maskData, setMaskData] = useState({});

  const fetchAndParseJson = (url, formData) =>
    fetch(url, { method: 'POST', body: formData })
      .then(async (res) => {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (err) {
          console.error("❌ JSON parse error. Raw response:", text);
          throw new Error("Invalid JSON");
        }
      });
  
  useEffect(() => {
    if (typeof sessionKey !== 'undefined') {
      const formData = new FormData();
      formData.append('sessionKey', sessionKey);
  
      fetchAndParseJson(`${APP_CONSTANTS.API_ORIGIN}/api/mask-data`, formData)
        .then((data) => {
          if (data?.error) {
            console.warn("Fallback to /upload_and_get_maskdata due to error in response");
            return fetchAndParseJson(`${APP_CONSTANTS.API_ORIGIN}/api/upload_and_get_maskdata`, formData);
          }
          return data;
        })
        .then((finalData) => {
          setMaskData(finalData);
        })
        .catch((err) => {
          console.error("[Final ERROR] Failed to fetch mask data:", err);
        });
    }
  }, [sessionKey]);
  
  
  return (
    <div className="ReportScreen">
      <div className="header-line"></div>
      <div className="ReportScreenHeader">
        <div>Tissue</div>
        <div>Volume</div>
        <div>Mean HU</div>
      </div>
      <div className="header-line"></div>
 
      <div className="items"> 
        {(typeof maskData.organ_metrics === 'undefined') ? (
          <div>Loading...</div>
        ) : (
          console.log('render'),
          maskData.organ_metrics.map((organData, i) => {
            const crossSectionArea = organData.volume_cm3;
            return (<ReportScreenItem
              key={i}
              tissue={filenameToName(organData.organ_name)}
              crossSectionArea={crossSectionArea}
              meanHU={organData.mean_hu}/>
          )})
        )} 
        <div className="header-line"></div>
      </div>
      
      
    </div>
  )
}

export default ReportScreen