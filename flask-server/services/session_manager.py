from models.base import db
from models.application_session import ApplicationSession
from models.combined_labels import CombinedLabels
from datetime import datetime, timedelta
from constants import Constants
import uuid
import shutil
import os

def generate_uuid():
    return str(uuid.uuid4())
class SessionManager(object):
    _instance = None

    @staticmethod
    def generate_uuid():
        """Compatibility wrapper for callers that obtain IDs from the manager."""
        return generate_uuid()

    def __init__(self):
        self.active_sessions = {}  # session_id -> ApplicationSession 映射表

    @classmethod
    def instance(cls):
        if cls._instance is None:
            print("Creating SessionManager Instance")
            cls._instance = cls.__new__(cls)
            cls._instance.__init__()  # ✅ 手动调用初始化
        return cls._instance

    def get_session(self, session_id):
        """Get ApplicationSession instance by session_id"""
        if session_id in self.active_sessions:
            return self.active_sessions[session_id]

        # 
        stmt = db.select(ApplicationSession).where(ApplicationSession.session_id == session_id)
        resp = db.session.execute(stmt)
        session = resp.scalar()

        if session is not None:
            self.active_sessions[session_id] = session  # 
        return session
    
    def register_session(self, session_id):
        """
        只注册 session_id，暂时不创建 ApplicationSession，等待后续信息完善。
        """
        self.active_sessions[session_id] = {
            "registered": True,
            "created_at": datetime.now()
        }
        print(f"[SessionManager] Registered new session_id (lazy mode): {session_id}")


    def validate_session(self, session_id):
        pass
        
    def validate_clabel(self, clabel_id):
        pass
        
    def terminate_session(self, session_id):
        
        stmt = db.select(ApplicationSession).where(ApplicationSession.session_id == session_id)
        resp = db.session.execute(stmt)
        app_session = resp.scalar()
        combined_labels_id = app_session.combined_labels_id

        stmt = db.select(CombinedLabels).where(CombinedLabels.combined_labels_id == combined_labels_id)
        resp = db.session.execute(stmt)
        combined_labels = resp.scalar()

        db.session.delete(app_session)
        db.session.delete(combined_labels)
        db.session.commit()
    

        try:
            print(f'removing session: {session_id}')
            shutil.rmtree(os.path.join(Constants.SESSIONS_DIR_NAME, session_id))
            return True
        except:
            return False

    def get_expired(self): #can only be used with app_context
        print("sched check")
        current_time = datetime.now()
        stmt = db.select(ApplicationSession).where(ApplicationSession.session_expire_date <= current_time)
        resp = db.session.execute(stmt)
        return resp.scalars().all()
    def update_session_info(self, session_id, main_nifti_path=None, combined_labels_id=None):
        """
        更新session信息，如果数据库不存在则创建新的ApplicationSession。
        """
        # 尝试先从数据库拿
        stmt = db.select(ApplicationSession).where(ApplicationSession.session_id == session_id)
        resp = db.session.execute(stmt)
        session = resp.scalar()

        if session is None:
            # 数据库里没有，需要新建 ApplicationSession
            if main_nifti_path is None:
                raise ValueError(f"Cannot create ApplicationSession for {session_id} without main_nifti_path!")

            created_at = datetime.now()
            expire_at = created_at + timedelta(days=3)

            session = ApplicationSession(
                session_id=session_id,
                main_nifti_path=main_nifti_path,
                combined_labels_id=combined_labels_id,
                session_created=created_at,
                session_expire_date=expire_at
            )

            db.session.add(session)
            print(f"[SessionManager] Created new ApplicationSession during update: {session_id}")
        else:
            # 数据库已有，直接update字段
            if main_nifti_path is not None:
                session.main_nifti_path = main_nifti_path
            if combined_labels_id is not None:
                session.combined_labels_id = combined_labels_id
            print(f"[SessionManager] Updated existing ApplicationSession: {session_id}")

        db.session.commit()
        self.active_sessions[session_id] = session
        return session

    def bind_combined_labels_to_session(self, session_id, clabel_path, organ_intensities=None):
        """
        根据已经存在的combined_labels_id创建CombinedLabels记录。
        必须保证ApplicationSession已经有了combined_labels_id。
        """
        # 拿到 session
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session {session_id} not found.")

        # 检查session是否已经有combined_labels_id
        combined_labels_id = session.combined_labels_id
        if combined_labels_id is None:
            raise ValueError(f"Session {session_id} does not have a combined_labels_id set yet.")

        # 用已有的combined_labels_id创建CombinedLabels
        new_clabel = CombinedLabels(
            combined_labels_id=combined_labels_id,
            combined_labels_path=clabel_path,
            organ_intensities=organ_intensities or {},
            organ_metadata={}
        )

        # 保存到数据库
        db.session.add(new_clabel)
        db.session.commit()

        print(f"[SessionManager] Bound existing CombinedLabels ID {combined_labels_id} to session {session_id}")
        return new_clabel


def deprecated_register_session(self, session_id, expire_minutes=60*24*3):
        """用已有的session_id创建并注册一个ApplicationSession到数据库和缓存"""
        created_at = datetime.now()
        expire_at = created_at + timedelta(minutes=expire_minutes)
        combined_labels_id =None
        main_nifti_path = None
        new_session = ApplicationSession(
            session_id=session_id,
            main_nifti_path=main_nifti_path,
            combined_labels_id=combined_labels_id,
            session_created=created_at,
            session_expire_date=expire_at,
        )

        db.session.add(new_session)
        db.session.commit()

        self.active_sessions[session_id] = new_session

        print(f"[SessionManager] Registered new session: {session_id}")
        return new_session
