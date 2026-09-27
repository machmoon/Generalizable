import React, { useEffect, useState } from 'react';
import { APP_CONSTANTS } from '../../helpers/constants';
import { type CheckBoxData } from '../../types';
import './NestedCheckBox.css';

type ChipBoxProps = {
  itemData: CheckBoxData;
  checkStateProp: boolean[];
  update: (id: number, checked: boolean) => void;
  rgbaVals: number[];
  checkBoxData: CheckBoxData[];
  onAdd?: (itemData: CheckBoxData) => void;
  isAll?: boolean;
  forceAdd?: boolean
}

type Props = {
  setCheckState: React.Dispatch<React.SetStateAction<boolean[]>>;
  checkBoxData: CheckBoxData[];
  checkState: boolean[];
  update: (id: number, checked: boolean) => void;
  sessionId: string | undefined;
  clabelId: string;
}

function ChipBox({ itemData, checkStateProp, update, rgbaVals, checkBoxData, isAll, onAdd, forceAdd }: ChipBoxProps) {
  const isChecked = checkStateProp[itemData.id];
  const label = itemData.label.replace(/_/g, ' ');
  const colorRGB = `rgba(${rgbaVals.slice(0, 3).join(',')}, 1)`;
  const showAsAdd = forceAdd ?? !isChecked;
  const handleClick = () => {
    if (onAdd) {
      onAdd(itemData);
    } else if (isAll) {
      const selectedItems = checkBoxData.filter(item => item.id !== 0 && !!checkStateProp[item.id]);
      selectedItems.forEach(item => update(item.id, false));
    } else {
      update(itemData.id, !isChecked);
    }
  };

  return (
    <div className="organ-chip" style={{ borderColor: colorRGB }}>
      <div className="organ-dot" style={{ backgroundColor: colorRGB }} />
      <span className="organ-label">{label}</span>
      <div
        className={`chip-button ${showAsAdd ? 'chip-add' : 'chip-close'}`}
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
      >
        {showAsAdd ? '＋' : '×'}
      </div>
    </div>
  );
}


function NestedCheckBox({ setCheckState, checkBoxData, checkState, update, sessionId, clabelId }: Props) {
  const [searchText, _setSearchText] = useState("");
  const [labelColorMap, setLabelColorMap] = useState<{ [key: number]: number[] }>({});
  // const chipContainerRef = useRef(null);

  const cacheKey = `labelColorMap_${sessionId}`;

  useEffect(() => {
    const fetchColorMap = async () => {
      try {
        // const cached = sessionStorage.getItem(cacheKey);
        // if (cached) {
        //   setLabelColorMap(JSON.parse(cached));
        //   return;
        // }
        const response = await fetch(`${APP_CONSTANTS.API_ORIGIN}/api/get-label-colormap/${clabelId}`);
        const lut = await response.json();
        const parsedMap: {[key: number]: number[]}= {};
        for (const labelId in lut) {
          const color = lut[labelId];
          if (color && color.R !== undefined) {
            parsedMap[Number(labelId)] = [color.R, color.G, color.B, color.A ?? 255];
          }
        }
        sessionStorage.setItem(cacheKey, JSON.stringify(parsedMap));
        setLabelColorMap(parsedMap);
      } catch (err) {
        console.warn("❗ Failed to fetch colormap:", err);
      }
    };

    fetchColorMap();
  }, [sessionId]);

  const handleSelectAllUnselected = () => {
    setCheckState(prev => {
      const newState = { ...prev };
      checkBoxData.forEach(item => {
        if (!prev[item.id]) {
          newState[item.id] = true;
        }
      });
      return newState;
    });
  };

  const handleUnselectAll = () => {
    setCheckState(prev => {
      const newState = { ...prev };
      checkBoxData.forEach(item => {
        newState[item.id] = false;
      });
      return newState;
    });
  };

  const normalizedSearch = searchText.trim().toLowerCase();
  const unselectedItems = checkBoxData.filter(item => item.id !== 0 && !checkState[item.id]);
  const selectedItems = checkBoxData.filter(item => item.id !== 0 && !!checkState[item.id]);
  const filteredUnselectedItems = unselectedItems.filter(item =>
    normalizedSearch === "" || item.label.toLowerCase().includes(normalizedSearch)
  );

  return (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', width: '100%' }}>
      {/* 左侧：搜索框 */}

  
      {/* 右侧两行 scroll 区域 */}
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '12px', minWidth: 0 }}>
        {/* 未选器官 */}
        <div className="organ-scroll-row" style={{ backgroundColor: '#1a1a1a' }}>
          <ChipBox
            itemData={{ id: 0, label: "All" }}
            isAll={true}
            checkStateProp={[]}
            update={update}
            checkBoxData={checkBoxData}
            onAdd={handleSelectAllUnselected}
            rgbaVals={[180, 180, 180, 255]}
            forceAdd={true}
          />
          {filteredUnselectedItems.map(item => (
            <ChipBox
              key={`suggest-${item.id}`}
              itemData={item}
              checkStateProp={checkState}
              update={update}
              checkBoxData={checkBoxData}
              rgbaVals={[180, 180, 180, 255]} // 灰色
            />
          ))}
          {filteredUnselectedItems.length === 0 && (
            <div style={{ padding: '5px', fontStyle: 'italic', color: '#999' }}>
              ✅ All organs are already added and displayed.
            </div>
          )}
        </div>
  
        {/* 已选器官 */}
        <div className="organ-scroll-row" style={{ backgroundColor: '#051131' }}>
          <ChipBox
            itemData={{ id: 0, label: 'All' }}
            isAll={true}
            checkStateProp={[]}
            update={update}
            checkBoxData={checkBoxData}
            onAdd={handleUnselectAll}
            rgbaVals={[255, 255, 255, 255]}
            forceAdd={false}
          />
          {selectedItems
            .filter(item => normalizedSearch === '' || item.label.toLowerCase().includes(normalizedSearch))
            .map(item => (
              <ChipBox
                key={`selected-${item.id}`}
                itemData={item}
                checkStateProp={checkState}
                update={update}
                checkBoxData={checkBoxData}
                rgbaVals={labelColorMap[item.id] || [150, 150, 150, 255]}
              />
            ))}
        </div>
      </div>
    </div>
  );
  
  
} 
export default NestedCheckBox;
