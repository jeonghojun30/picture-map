/**
 * Photo Map Explorer - 부동산 실거래가 스타일 인터랙티브 사진 지도 (고성능 경량 버전)
 */

// 애플리케이션 상태 관리 (가볍고 빠른 메모리 기반 + 로컬 파일 참조)
const AppState = {
  photos: [],
  map: null,
  clusterGroup: null,
  markersMap: new Map(), // photo.id -> L.Marker
  currentTileLayer: null,
  currentLabelLayer: null,
  currentModalIndex: -1,
  manualPinMode: false,
  pendingPhotoWithoutGps: null,
  activeFilter: "",
  currentSort: "name-asc"
};

// 타일 레이어 정의
const TILE_CONFIGS = {
  vworld_base: {
    name: "VWorld 공공지도",
    url: "https://xdworld.vworld.kr/2d/Base/service/{z}/{x}/{y}.png",
    attribution: '&copy; 공간정보오픈플랫폼 VWorld 국토교통부',
    maxZoom: 19,
    labels: null
  },
  vworld_satellite: {
    name: "VWorld 공공 위성",
    url: "https://xdworld.vworld.kr/2d/Satellite/service/{z}/{x}/{y}.jpeg",
    attribution: '&copy; 공간정보오픈플랫폼 VWorld 국토교통부 항공위성',
    maxZoom: 19,
    labels: "https://xdworld.vworld.kr/2d/Hybrid/service/{z}/{x}/{y}.png"
  },
  osm_detailed: {
    name: "상세 도로명·건물명",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    labels: null
  },
  satellite_hybrid: {
    name: "글로벌 위성 + 도로명",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a> &copy; OpenStreetMap',
    maxZoom: 19,
    labels: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
  },
  voyager: {
    name: "모던 시티",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
    labels: null
  },
  dark: {
    name: "다크 모드",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
    labels: null
  }
};

// ==========================================================================
// 1. 초기화 & 지도 설정
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initEventListeners();
  loadInitialPhotos();
  initDropZone();
});

function initMap() {
  // 효창공원 중심 좌표로 초기화 (최대 줌 레벨을 22로 대폭 확장하여 초정밀 골목/건물 단위 확대 가능)
  AppState.map = L.map("map", {
    center: [37.54505, 126.96031],
    zoom: 16,
    minZoom: 3,
    maxZoom: 22,
    zoomControl: false,
    wheelPxPerZoomLevel: 70
  });

  // 줌 컨트롤 위치 조정 (우측 하단)
  L.control.zoom({ position: "bottomright" }).addTo(AppState.map);

  // 기본 지도: VWorld 공공지도 (국토부 도로명 지도)
  switchMapTileStyle("vworld_base");

  // 부동산 실거래가 스타일의 커스텀 클러스터 그룹 생성 (중간 줌 레벨 수량 뭉침 + 최대 줌 개별 노출)
  AppState.clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 55,             // 16~19레벨에서는 인접 사진들이 숫자로 뭉쳐서 수량 표시
    disableClusteringAtZoom: 20,       // 최대 줌(20~22레벨)에 도달했을 때 100% 개별 사진 핀으로 분기
    spiderfyOnMaxZoom: true,          // 같은 위치에 겹친 사진들은 클릭 시 부드럽게 꽃잎처럼 펼침
    zoomToBoundsOnClick: true,
    iconCreateFunction: createClusterIcon
  });

  AppState.map.addLayer(AppState.clusterGroup);

  // 지도 이동 시 사이드 갤러리 및 통계 업데이트
  AppState.map.on("moveend", updateVisiblePhotosFeed);
  AppState.map.on("click", handleMapClickForManualPin);
}

// 부동산 앱(호갱노노/직방) 스타일의 원형 뱃지 클러스터 아이콘 생성
function createClusterIcon(cluster) {
  const count = cluster.getChildCount();
  let sizeClass = "re-cluster-small";
  let labelText = "장";

  if (count >= 30) {
    sizeClass = "re-cluster-large";
  } else if (count >= 10) {
    sizeClass = "re-cluster-medium";
  }

  const html = `
    <div class="re-cluster-bubble ${sizeClass}">
      <span class="re-cluster-count">${count}</span>
      <span class="re-cluster-label">${labelText}</span>
    </div>
  `;

  return L.divIcon({
    html: html,
    className: "re-cluster-marker",
    iconSize: L.point(48, 48),
    iconAnchor: [24, 24]
  });
}

// ==========================================================================
// 2. 사진 마커 생성 & 팝업
// ==========================================================================
function createPhotoMarker(photo) {
  const markerHtml = `
    <div class="re-photo-marker" data-photo-id="${photo.id}">
      <div class="photo-pin-head">
        <img src="${photo.thumbnail || photo.url}" class="photo-pin-thumb" alt="${escapeHtml(photo.name)}" loading="lazy" />
      </div>
      <div class="photo-pin-tip"></div>
    </div>
  `;

  const customIcon = L.divIcon({
    html: markerHtml,
    className: "re-custom-div-icon",
    iconSize: [44, 52],
    iconAnchor: [22, 52],
    popupAnchor: [0, -48]
  });

  const marker = L.marker([photo.lat, photo.lng], { icon: customIcon });

  // 팝업 HTML (약 5배 확대된 시원한 프리미엄 카드 레이아웃)
  const popupContent = `
    <div class="photo-popup-card">
      <div class="popup-img-wrap" onclick="openPhotoModal('${photo.id}')">
        <img src="${photo.url || photo.thumbnail}" class="popup-img" alt="${escapeHtml(photo.name)}" />
        <div class="popup-expand-hint">
          <i data-lucide="maximize-2" style="width:16px;height:16px;"></i> 전체화면 뷰어
        </div>
        ${photo.category ? `<div class="popup-category-badge">${escapeHtml(photo.category)}</div>` : ''}
      </div>
      <div class="popup-body">
        <div class="popup-title" title="${escapeHtml(photo.name)}">${escapeHtml(photo.name)}</div>
        <div class="popup-meta">
          <div class="popup-meta-row">
            <i data-lucide="map-pin" style="width:15px;height:15px;color:var(--primary);flex-shrink:0;"></i>
            <span class="popup-meta-text">${escapeHtml(photo.locationName || `${photo.lat.toFixed(5)}, ${photo.lng.toFixed(5)}`)}</span>
          </div>
          <div class="popup-meta-row">
            <i data-lucide="calendar" style="width:15px;height:15px;color:var(--text-dim);flex-shrink:0;"></i>
            <span>${escapeHtml(photo.date || "촬영일 미상")}</span>
            ${photo.camera ? `<span class="popup-meta-sep">•</span><i data-lucide="camera" style="width:14px;height:14px;color:var(--text-dim);flex-shrink:0;"></i><span>${escapeHtml(photo.camera)}</span>` : ''}
            ${photo.fileSize ? `<span class="popup-meta-sep">•</span><span>${escapeHtml(photo.fileSize)}</span>` : ''}
          </div>
        </div>
        <div class="popup-actions">
          <button class="popup-btn popup-btn-primary" onclick="openPhotoModal('${photo.id}')">
            <i data-lucide="eye" style="width:16px;height:16px;"></i> 원본 고화질 & EXIF 상세
          </button>
          <button class="popup-btn" onclick="downloadSinglePhoto('${photo.id}', event)">
            <i data-lucide="download" style="width:16px;height:16px;"></i> 다운로드
          </button>
          <button class="popup-btn popup-btn-danger" onclick="deletePhoto('${photo.id}', event)">
            <i data-lucide="trash-2" style="width:16px;height:16px;"></i> 사진 제거
          </button>
        </div>
      </div>
    </div>
  `;

  marker.bindPopup(popupContent, { 
    maxWidth: 620, 
    minWidth: 480, 
    className: "re-large-popup",
    autoPanPadding: [50, 50]
  });
  marker.on("popupopen", () => lucide.createIcons());

  return marker;
}

function renderPhotoMarkers(photosToRender = AppState.photos) {
  AppState.clusterGroup.clearLayers();
  AppState.markersMap.clear();

  photosToRender.forEach(photo => {
    if (photo.lat && photo.lng) {
      const marker = createPhotoMarker(photo);
      AppState.clusterGroup.addLayer(marker);
      AppState.markersMap.set(photo.id, marker);
    }
  });

  updateStats();
  updateVisiblePhotosFeed();
}

// ==========================================================================
// 3. 사진 삭제(제거) 기능 (초고속 반응)
// ==========================================================================
function deletePhoto(photoId, e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }

  const targetPhoto = AppState.photos.find(p => p.id === photoId);
  if (!targetPhoto) return;

  const confirmDelete = confirm(`'${targetPhoto.name}' 사진을 지도에서 제거하시겠습니까?`);
  if (!confirmDelete) return;

  // 1. 상태 배열에서 제거
  AppState.photos = AppState.photos.filter(p => p.id !== photoId);

  // 2. 지도 마커 및 클러스터 레이어에서 제거
  const marker = AppState.markersMap.get(photoId);
  if (marker) {
    AppState.clusterGroup.removeLayer(marker);
    AppState.markersMap.delete(photoId);
  }

  // 3. 모달이 열려있는 상태였다면 모달 닫기
  const modal = document.getElementById("photo-modal");
  if (modal && modal.classList.contains("active")) {
    closePhotoModal();
  }

  // 4. 사이드바 및 통계 갱신
  updateStats();
  updateVisiblePhotosFeed();

  showToast(`'${targetPhoto.name}' 사진이 제거되었습니다. 🗑️`, "info");
}

function deleteCurrentModalPhoto() {
  const photo = AppState.photos[AppState.currentModalIndex];
  if (photo) {
    deletePhoto(photo.id);
  }
}

// ==========================================================================
// 4. 사진 업로드 & EXIF 메타데이터 GPS 추출 (초고속 ObjectURL 처리)
// ==========================================================================
async function processUploadedFiles(fileList) {
  const files = Array.from(fileList).filter(file => file.type.startsWith("image/"));
  if (files.length === 0) {
    showToast("지원되는 이미지 파일(JPG, PNG, WEBP)이 없습니다.", "warning");
    return;
  }

  let successCount = 0;
  let noGpsCount = 0;
  showToast(`${files.length}개의 사진 메타데이터(GPS)를 분석하는 중...`, "info");

  for (const file of files) {
    try {
      const photoData = await parseImageFile(file);
      
      if (photoData.lat && photoData.lng) {
        AppState.photos.unshift(photoData);
        successCount++;
      } else {
        noGpsCount++;
        if (!AppState.pendingPhotoWithoutGps) {
          AppState.pendingPhotoWithoutGps = photoData;
        }
      }
    } catch (err) {
      console.error("EXIF 파싱 오류:", file.name, err);
    }
  }

  renderPhotoMarkers();

  if (successCount > 0) {
    showToast(`총 ${successCount}장의 사진이 지도에 등록되었습니다! 📍`, "success");
    const firstAdded = AppState.photos[0];
    if (firstAdded) {
      AppState.map.flyTo([firstAdded.lat, firstAdded.lng], 16, { duration: 1.0 });
    }
  }

  if (noGpsCount > 0) {
    showToast(`${noGpsCount}장의 사진에 GPS 정보가 없습니다. 지도를 클릭해 위치를 지정해주세요.`, "warning");
    enableManualPinMode();
  }
}

async function parseImageFile(file) {
  // 메모리 낭비 없이 0초 만에 렌더링되는 경량 ObjectURL 생성
  const objectUrl = URL.createObjectURL(file);
  let exifData = {};

  try {
    if (window.exifr) {
      exifData = await exifr.parse(file, {
        gps: true,
        tiff: true,
        exif: true,
        pick: ['latitude', 'longitude', 'DateTimeOriginal', 'Make', 'Model', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength']
      }) || {};
    }
  } catch (e) {
    console.warn("EXIF 파싱 실패:", e);
  }

  const id = "photo-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
  const formattedDate = exifData.DateTimeOriginal 
    ? new Date(exifData.DateTimeOriginal).toLocaleString("ko-KR")
    : new Date(file.lastModified).toLocaleString("ko-KR");

  const photo = {
    id: id,
    name: file.name,
    file: file,
    url: objectUrl,
    thumbnail: objectUrl,
    lat: exifData.latitude || null,
    lng: exifData.longitude || null,
    date: formattedDate,
    camera: (exifData.Make ? exifData.Make + " " : "") + (exifData.Model || "스마트폰/카메라"),
    focalLength: exifData.FocalLength ? `${exifData.FocalLength}mm` : "-",
    aperture: exifData.FNumber ? `f/${exifData.FNumber}` : "-",
    iso: exifData.ISO ? `${exifData.ISO}` : "-",
    shutterSpeed: exifData.ExposureTime ? formatShutterSpeed(exifData.ExposureTime) : "-",
    fileSize: (file.size / (1024 * 1024)).toFixed(2) + " MB",
    locationName: ""
  };

  if (photo.lat && photo.lng) {
    reverseGeocode(photo.lat, photo.lng).then((addr) => {
      photo.locationName = addr;
      updateVisiblePhotosFeed();
    });
  }

  return photo;
}

function formatShutterSpeed(val) {
  if (!val) return "-";
  if (val >= 1) return val + "s";
  return `1/${Math.round(1 / val)}s`;
}

// OpenStreetMap Nominatim 역지오코딩
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`);
    if (!res.ok) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const data = await res.json();
    return data.display_name ? data.display_name.split(",").slice(0, 3).join(", ") : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch (e) {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

// ==========================================================================
// 5. 수동 핀 지정 모드 (GPS 없는 사진용)
// ==========================================================================
function enableManualPinMode() {
  AppState.manualPinMode = true;
  document.getElementById("map").style.cursor = "crosshair";
}

async function handleMapClickForManualPin(e) {
  if (!AppState.manualPinMode || !AppState.pendingPhotoWithoutGps) return;

  const { lat, lng } = e.latlng;
  const photo = AppState.pendingPhotoWithoutGps;
  photo.lat = lat;
  photo.lng = lng;

  const addr = await reverseGeocode(lat, lng);
  photo.locationName = addr;

  AppState.photos.unshift(photo);
  AppState.pendingPhotoWithoutGps = null;
  AppState.manualPinMode = false;
  document.getElementById("map").style.cursor = "";

  renderPhotoMarkers();
  showToast(`'${photo.name}' 위치가 지정되었습니다! 📌`, "success");
}

// ==========================================================================
// 6. 사이드바 갤러리 피드 & 지도 뷰포트 동기화 & 정렬
// ==========================================================================
function updateVisiblePhotosFeed() {
  let bounds = null;
  try {
    bounds = AppState.map.getBounds();
  } catch(e) {
    bounds = null;
  }

  const hasValidBounds = bounds && typeof bounds.isValid === 'function' && bounds.isValid();
  const paddedBounds = hasValidBounds ? bounds.pad(0.08) : null;

  let visiblePhotos = AppState.photos.filter(p => {
    if (!p.lat || !p.lng) return false;
    
    // 검색어 필터링
    const matchesFilter = !AppState.activeFilter || 
      p.name.toLowerCase().includes(AppState.activeFilter.toLowerCase()) || 
      (p.locationName && p.locationName.toLowerCase().includes(AppState.activeFilter.toLowerCase()));
    
    if (!matchesFilter) return false;

    // 지도 영역(바운즈) 내 포함 여부
    if (paddedBounds) {
      try {
        return paddedBounds.contains(L.latLng(p.lat, p.lng));
      } catch(e) {
        return true;
      }
    }
    return true;
  });

  // 검색어가 없는 상태에서 바운즈 계산 오차 등으로 0개가 나오면 전체 사진으로 안전하게 대체
  if (visiblePhotos.length === 0 && !AppState.activeFilter && AppState.photos.length > 0) {
    visiblePhotos = [...AppState.photos];
  }

  // 정렬 적용 (오름차순, 내림차순, 일시순)
  visiblePhotos.sort((a, b) => {
    if (AppState.currentSort === "name-asc") {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (AppState.currentSort === "name-desc") {
      return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (AppState.currentSort === "date-desc") {
      return (b.date || "").localeCompare(a.date || "");
    } else if (AppState.currentSort === "date-asc") {
      return (a.date || "").localeCompare(b.date || "");
    }
    return 0;
  });

  const countBadge = document.getElementById("visible-photo-count");
  if (countBadge) countBadge.textContent = visiblePhotos.length;

  const galleryList = document.getElementById("drawer-gallery-list");
  if (!galleryList) return;

  if (visiblePhotos.length === 0) {
    galleryList.innerHTML = `
      <div class="empty-gallery">
        <i data-lucide="map-off" style="width:36px;height:36px;margin-bottom:10px;opacity:0.5;"></i>
        <p>현재 지도 영역에 등록된 사진이 없습니다.</p>
        <span style="font-size:11px;color:var(--text-dim);">지도를 이동하거나 검색어를 변경해보세요.</span>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  galleryList.innerHTML = visiblePhotos.map(photo => `
    <div class="gallery-card" onclick="flyToAndOpenPhoto('${photo.id}')">
      <button class="gallery-card-del-btn" onclick="deletePhoto('${photo.id}', event)" title="사진 삭제">
        <i data-lucide="trash-2" style="width:13px;height:13px;"></i>
      </button>
      <div class="gallery-card-thumb-wrap">
        <img src="${escapeHtml(photo.thumbnail || photo.url)}" 
             class="gallery-card-thumb" 
             alt="${escapeHtml(photo.name)}" 
             loading="lazy" 
             onerror="this.onerror=null;this.src='${escapeHtml(photo.url)}';" />
      </div>
      <div class="gallery-card-info">
        <div class="gallery-card-name" title="${escapeHtml(photo.name)}">${escapeHtml(photo.name)}</div>
        <div class="gallery-card-date">${escapeHtml(photo.date || "날짜 정보 없음")}</div>
      </div>
    </div>
  `).join("");

  lucide.createIcons();
}

function flyToAndOpenPhoto(photoId) {
  const photo = AppState.photos.find(p => p.id === photoId);
  if (!photo) return;

  AppState.map.flyTo([photo.lat, photo.lng], 17, { duration: 0.8 });

  setTimeout(() => {
    const marker = AppState.markersMap.get(photoId);
    if (marker) {
      AppState.clusterGroup.zoomToShowLayer(marker, () => {
        marker.openPopup();
      });
    }
  }, 900);
}

// ==========================================================================
// 7. 고화질 모달 라이트박스 뷰어 & EXIF 상세 인스펙터
// ==========================================================================
function openPhotoModal(photoId) {
  const index = AppState.photos.findIndex(p => p.id === photoId);
  if (index === -1) return;

  AppState.currentModalIndex = index;
  renderModalContent();

  const modal = document.getElementById("photo-modal");
  modal.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closePhotoModal() {
  const modal = document.getElementById("photo-modal");
  modal.classList.remove("active");
  document.body.style.overflow = "";
}

function renderModalContent() {
  const photo = AppState.photos[AppState.currentModalIndex];
  if (!photo) return;

  document.getElementById("modal-img").src = photo.url;
  document.getElementById("modal-photo-name").textContent = photo.name;
  document.getElementById("modal-location-text").textContent = photo.locationName || `${photo.lat.toFixed(5)}, ${photo.lng.toFixed(5)}`;

  document.getElementById("modal-exif-date").textContent = photo.date || "정보 없음";
  document.getElementById("modal-exif-camera").textContent = photo.camera || "기종 미상";
  document.getElementById("modal-exif-focal").textContent = photo.focalLength || "-";
  document.getElementById("modal-exif-aperture").textContent = photo.aperture || "-";
  document.getElementById("modal-exif-iso").textContent = photo.iso || "-";
  document.getElementById("modal-exif-shutter").textContent = photo.shutterSpeed || "-";
  document.getElementById("modal-exif-gps").textContent = `${photo.lat.toFixed(6)}, ${photo.lng.toFixed(6)}`;
  document.getElementById("modal-exif-size").textContent = photo.fileSize || "웹 원본";

  lucide.createIcons();
}

function nextModalPhoto() {
  if (AppState.photos.length === 0) return;
  AppState.currentModalIndex = (AppState.currentModalIndex + 1) % AppState.photos.length;
  renderModalContent();
}

function prevModalPhoto() {
  if (AppState.photos.length === 0) return;
  AppState.currentModalIndex = (AppState.currentModalIndex - 1 + AppState.photos.length) % AppState.photos.length;
  renderModalContent();
}

// ==========================================================================
// 8. 사진 다운로드 및 ZIP 일괄 다운로드
// ==========================================================================
async function downloadSinglePhoto(photoId, e) {
  if (e) e.stopPropagation();
  const photo = AppState.photos.find(p => p.id === photoId);
  if (!photo) return;

  showToast(`'${photo.name}' 다운로드 중...`, "info");

  try {
    if (photo.file) {
      const a = document.createElement("a");
      a.href = photo.url;
      a.download = photo.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast("다운로드가 완료되었습니다! 💾", "success");
      return;
    }

    const response = await fetch(photo.url);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = photo.name.endsWith(".jpg") || photo.name.endsWith(".png") ? photo.name : `${photo.name}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);

    showToast("다운로드가 완료되었습니다! 💾", "success");
  } catch (err) {
    console.error("다운로드 실패:", err);
    window.open(photo.url, "_blank");
  }
}

function downloadCurrentModalPhoto() {
  const photo = AppState.photos[AppState.currentModalIndex];
  if (photo) {
    downloadSinglePhoto(photo.id);
  }
}

async function downloadAllPhotosZip() {
  if (AppState.photos.length === 0) {
    showToast("다운로드할 사진이 없습니다.", "warning");
    return;
  }

  showToast(`전체 ${AppState.photos.length}장의 사진을 ZIP 압축 중...`, "info");

  try {
    const zip = new JSZip();
    const folder = zip.folder("PhotoMap_GPS_Export");

    let count = 0;
    for (const photo of AppState.photos) {
      try {
        let blob;
        if (photo.file) {
          blob = photo.file;
        } else {
          const res = await fetch(photo.url);
          blob = await res.blob();
        }
        const fileName = photo.name.includes(".") ? photo.name : `${photo.name}.jpg`;
        folder.file(`${String(count + 1).padStart(2, "0")}_${fileName}`, blob);
        count++;
      } catch (e) {
        console.warn("사진 ZIP 추가 실패:", photo.name, e);
      }
    }

    const metadataReport = AppState.photos.map(p => ({
      name: p.name,
      latitude: p.lat,
      longitude: p.lng,
      address: p.locationName,
      date: p.date,
      camera: p.camera
    }));
    folder.file("GPS_Photo_Locations.json", JSON.stringify(metadataReport, null, 2));

    const content = await zip.generateAsync({ type: "blob" });
    const zipUrl = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = zipUrl;
    a.download = `PhotoMap_Export_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(zipUrl);

    showToast(`전체 사진 ZIP 다운로드가 완료되었습니다! 🎉`, "success");
  } catch (err) {
    console.error("ZIP 생성 오류:", err);
    showToast("ZIP 압축 생성 중 오류가 발생했습니다.", "warning");
  }
}

// ==========================================================================
// 9. 깃허브 배포용 sample-data.js 내보내기 & 리셋
// ==========================================================================
function exportSampleDataJs() {
  if (AppState.photos.length === 0) {
    showToast("내보낼 사진 데이터가 없습니다.", "warning");
    return;
  }

  const exportData = AppState.photos.map((p, idx) => ({
    id: `sample-photo-${String(idx + 1).padStart(2, '0')}`,
    name: p.name,
    url: p.file ? `images/${p.name}` : p.url,
    thumbnail: p.file ? `images/${p.name}` : (p.thumbnail || p.url),
    lat: p.lat,
    lng: p.lng,
    date: p.date,
    camera: p.camera,
    focalLength: p.focalLength,
    aperture: p.aperture,
    iso: p.iso,
    shutterSpeed: p.shutterSpeed,
    locationName: p.locationName,
    fileSize: p.fileSize
  }));

  const jsContent = `// 깃허브 배포용 sample-data.js (${new Date().toLocaleString("ko-KR")})\nconst INITIAL_PHOTO_SAMPLES = ${JSON.stringify(exportData, null, 2)};\n`;
  
  const blob = new Blob([jsContent], { type: "application/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sample-data.js";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast("sample-data.js 가 다운로드되었습니다! 깃허브에 덮어쓰기(Commit)하세요. 🚀", "success");
}

function resetToSampleData() {
  if (typeof INITIAL_PHOTO_SAMPLES !== "undefined" && INITIAL_PHOTO_SAMPLES.length > 0) {
    AppState.photos = [...INITIAL_PHOTO_SAMPLES];
    renderPhotoMarkers();
    showToast("기본 샘플 사진 세트로 복원되었습니다! 🔄", "info");
  }
}

function clearAllPhotos() {
  if (AppState.photos.length === 0) {
    showToast("삭제할 사진이 없습니다.", "warning");
    return;
  }
  const ok = confirm("등록된 모든 사진을 삭제하시겠습니까?");
  if (!ok) return;

  AppState.photos = [];
  renderPhotoMarkers();
  showToast("모든 사진이 제거되었습니다. 🗑️", "info");
}

// ==========================================================================
// 10. 드래그앤드롭 & 이벤트 리스너 & 타일 스위처
// ==========================================================================
function initDropZone() {
  const dropOverlay = document.getElementById("drop-overlay");
  let dragCounter = 0;

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add("dragging");
  });

  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove("dragging");
    }
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove("dragging");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processUploadedFiles(e.dataTransfer.files);
    }
  });
}

function initEventListeners() {
  const fileInput = document.getElementById("file-input");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        processUploadedFiles(e.target.files);
        fileInput.value = "";
      }
    });
  }

  // 폴더 단위 선택 인풋
  const folderInput = document.getElementById("folder-input");
  if (folderInput) {
    folderInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        processUploadedFiles(e.target.files);
        folderInput.value = "";
      }
    });
  }

  // 타일 스타일 전환 탭
  document.querySelectorAll(".style-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".style-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const styleKey = tab.dataset.style;
      switchMapTileStyle(styleKey);
    });
  });

  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      AppState.activeFilter = e.target.value;
      updateVisiblePhotosFeed();
    });
  }

  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      AppState.currentSort = e.target.value;
      updateVisiblePhotosFeed();
    });
  }

  const sideDrawer = document.getElementById("side-drawer");
  const drawerToggleBtn = document.getElementById("drawer-toggle-btn");
  const drawerCloseBtn = document.getElementById("drawer-close-btn");

  if (drawerCloseBtn) {
    drawerCloseBtn.addEventListener("click", () => {
      sideDrawer.classList.add("collapsed");
      drawerToggleBtn.style.display = "flex";
    });
  }

  if (drawerToggleBtn) {
    drawerToggleBtn.addEventListener("click", () => {
      sideDrawer.classList.remove("collapsed");
      drawerToggleBtn.style.display = "none";
    });
  }

  window.addEventListener("keydown", (e) => {
    const modal = document.getElementById("photo-modal");
    if (modal.classList.contains("active")) {
      if (e.key === "Escape") closePhotoModal();
      if (e.key === "ArrowRight") nextModalPhoto();
      if (e.key === "ArrowLeft") prevModalPhoto();
    }
  });

  const photoModal = document.getElementById("photo-modal");
  if (photoModal) {
    photoModal.addEventListener("click", (e) => {
      if (e.target === photoModal) closePhotoModal();
    });
  }
}

function switchMapTileStyle(styleKey) {
  const config = TILE_CONFIGS[styleKey];
  if (!config) return;

  if (AppState.currentTileLayer) {
    AppState.map.removeLayer(AppState.currentTileLayer);
  }
  if (AppState.currentLabelLayer) {
    AppState.map.removeLayer(AppState.currentLabelLayer);
    AppState.currentLabelLayer = null;
  }

  AppState.currentTileLayer = L.tileLayer(config.url, {
    attribution: config.attribution,
    maxNativeZoom: config.maxZoom || 19,
    maxZoom: 22,
    subdomains: ['a', 'b', 'c']
  }).addTo(AppState.map);

  if (config.labels) {
    AppState.currentLabelLayer = L.tileLayer(config.labels, {
      maxNativeZoom: config.maxZoom || 19,
      maxZoom: 22,
      pane: 'overlayPane'
    }).addTo(AppState.map);
  }

  if (styleKey === "vworld_base" || styleKey === "osm_detailed" || styleKey === "voyager") {
    document.body.classList.add("light-theme");
  } else {
    document.body.classList.remove("light-theme");
  }
}

function loadInitialPhotos() {
  if (typeof INITIAL_PHOTO_SAMPLES !== "undefined" && INITIAL_PHOTO_SAMPLES.length > 0) {
    AppState.photos = [...INITIAL_PHOTO_SAMPLES];
  }
  renderPhotoMarkers();

  // 모든 사진이 포함되도록 지도 뷰포트 자동 맞춤
  if (AppState.clusterGroup && AppState.clusterGroup.getLayers().length > 0) {
    const bounds = AppState.clusterGroup.getBounds();
    if (bounds.isValid()) {
      AppState.map.fitBounds(bounds.pad(0.1));
    }
  }
}

function updateStats() {
  const totalCountEl = document.getElementById("total-photos-count");
  if (totalCountEl) totalCountEl.textContent = AppState.photos.length;
}

function copyGpsToClipboard() {
  const photo = AppState.photos[AppState.currentModalIndex];
  if (!photo) return;
  const coords = `${photo.lat}, ${photo.lng}`;
  navigator.clipboard.writeText(coords).then(() => {
    showToast("GPS 좌표가 클립보드에 복사되었습니다! 📋", "info");
  });
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i data-lucide="${type === 'success' ? 'check-circle' : type === 'warning' ? 'alert-triangle' : 'info'}" style="width:16px;height:16px;"></i>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
