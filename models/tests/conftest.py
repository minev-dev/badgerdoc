import contextlib
import json
from typing import Iterable

import boto3
import pytest
from botocore.config import Config
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_s3
from sqlalchemy.orm import Session

from src.constants import MINIO_ACCESS_KEY, MINIO_HOST, MINIO_SECRET_KEY
from src.db import Base, Basement, Training, engine
from src.main import app
from src.routers import tenant

from .override_app_dependency import override
from .test_colab_start_training import (
    BASEMENT_ID,
    EXIST_TRAINING_ID,
    TRAINING_ARCHIVE_DATA,
    TRAINING_ARCHIVE_KEY,
    TRAINING_SCRIPT_DATA,
    TRAINING_SCRIPT_KEY,
)
from .test_crud import GET_BASEMENT, GET_LATEST_MODELS, GET_TRAINING
from .test_utils import TEST_LIMITS, TEST_TENANT


@pytest.fixture(scope="function")
def client() -> TestClient:
    client = TestClient(app)
    return client


@pytest.fixture
def overrided_token_client(client) -> TestClient:
    app.dependency_overrides[tenant] = override
    yield client
    app.dependency_overrides[tenant] = tenant


@pytest.fixture(scope="module")
def moto_minio() -> boto3.resource:
    """Creates and returns moto resource for s3 (minio) with test Bucket."""
    with mock_s3():
        minio_resource = boto3.resource(
            "s3", config=Config(signature_version="s3v4")
        )
        minio_resource.create_bucket(Bucket=TEST_TENANT)

        yield minio_resource


@pytest.fixture
def save_object_minio(request, moto_minio) -> boto3.resource:
    """Creates Object in minio with data and key provided in test's request."""
    minio_obj, minio_key = request.param
    moto_minio.Bucket(TEST_TENANT).put_object(
        Body=json.dumps(minio_obj),
        Key=minio_key,
    )
    return moto_minio


@pytest.fixture
def create_minio_bucket() -> boto3.resource:
    """This fixture is used to create test Bucket in minio instance during
    integration tests if not exists. Deletes test bucket on tear-down.
    """
    minio_resource = boto3.resource(
        "s3",
        endpoint_url=f"http://{MINIO_HOST}",
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4"),
    )
    try:
        minio_resource.meta.client.head_bucket(Bucket=TEST_TENANT)
    except ClientError:
        minio_resource.create_bucket(Bucket=TEST_TENANT)
    yield minio_resource
    minio_resource.meta.client.delete_bucket(Bucket=TEST_TENANT)


def close_session(gen):
    try:
        next(gen)
    except StopIteration:
        pass


def add_objects(db: Session, objects: Iterable[Base]) -> None:
    for obj in objects:
        db.merge(obj)
    db.commit()


def clear_db():
    """
    Clear db
    reversed(Base.metadata.sorted_tables) makes
    it so children are deleted before parents.
    """
    with contextlib.closing(engine.connect()) as con:
        trans = con.begin()
        for table in reversed(Base.metadata.sorted_tables):
            con.execute(table.delete())
        sequences = con.execute("SELECT * FROM information_schema.sequences")
        for sequence in sequences:
            sequence_name = sequence[2]
            con.execute(f"ALTER SEQUENCE {sequence_name} RESTART WITH 1")
        trans.commit()


@pytest.fixture(scope="module")
def db_session() -> Session:
    """Creates all tables on setUp, yields SQLAlchemy session and removes
    tables on tearDown.
    """
    from src.db import get_db

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    clear_db()
    gen = get_db()
    session = next(gen)

    yield session

    close_session(gen)


@pytest.fixture
def prepare_db_model(db_session) -> Session:
    """Creates model with basement for integration test in test_crud."""
    add_objects(db_session, [GET_BASEMENT, GET_TRAINING])

    yield db_session

    clear_db()


@pytest.fixture
def prepare_db_start_training(db_session, request) -> Session:
    """Creates basement with key_script (from tests request.param) and
    key_archive field values.
    """
    basement = Basement(
        id=BASEMENT_ID,
        key_script=request.param,
        key_archive=TRAINING_ARCHIVE_KEY,
        limits=TEST_LIMITS,
    )
    training = Training(id=EXIST_TRAINING_ID, basement=BASEMENT_ID)
    db_session.add_all([basement, training])
    db_session.commit()

    yield db_session

    clear_db()


@pytest.fixture
def save_start_training_minio_objects(moto_minio) -> boto3.resource:
    """Creates "basements/base_id/training_script.py" and
    "basements/base_id/training_archive.zip" in minio with test data.
    """
    training_script_key = TRAINING_SCRIPT_KEY
    training_archive_key = TRAINING_ARCHIVE_KEY
    training_script = TRAINING_SCRIPT_DATA
    training_archive = TRAINING_ARCHIVE_DATA
    moto_minio.Bucket(TEST_TENANT).put_object(
        Body=training_script.encode("utf-8"), Key=training_script_key
    )
    moto_minio.Bucket(TEST_TENANT).put_object(
        Body=training_archive.encode("utf-8"), Key=training_archive_key
    )
    return moto_minio


@pytest.fixture(scope="module")
def db_get_latest_model(db_session) -> Session:
    add_objects(db_session, [GET_BASEMENT, *GET_LATEST_MODELS])

    yield db_session

    clear_db()
