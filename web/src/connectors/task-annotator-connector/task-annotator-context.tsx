import React, {
    createContext,
    FC,
    MutableRefObject,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react';
import { cloneDeep } from 'lodash';
import { Task } from 'api/typings/tasks';
import { useSetTaskFinished, useTaskById } from 'api/hooks/tasks';
import { useCategoriesByJob } from 'api/hooks/categories';
import {
    Category,
    CategoryDataAttributeWithValue,
    ExternalViewerState,
    FileDocument,
    Filter,
    Link,
    Operators,
    User
} from 'api/typings';
import { useDocuments } from 'api/hooks/documents';
import { documentSearchResultMapper } from 'shared/helpers/document-search-result-mapper';
import { FileMetaInfo } from 'pages/document/document-page-sidebar-content/document-page-sidebar-content';
import { useAddAnnotationsMutation, useLatestAnnotations } from 'api/hooks/annotations';
import { useTokens } from 'api/hooks/tokens';
import {
    Annotation,
    AnnotationBoundType,
    AnnotationLinksBoundType,
    PageToken,
    Maybe,
    TableGutterMap,
    AnnotationImageToolType,
    PaperToolParams,
    toolNames,
    PaperTool
} from 'shared';
import { ApiError } from 'api/api-error';
import { useUsersDataFromTask } from './user-fetch-hook';
import {
    defaultExternalViewer,
    getCategoryDataAttrs,
    isValidCategoryType,
    mapAnnDataAttrs,
    mapAnnotationDataAttrsFromApi,
    mapAnnotationPagesFromApi,
    mapModifiedAnnotationPagesToApi,
    mapTokenPagesFromApi
} from './task-annotator-utils';
import { QueryObserverResult, RefetchOptions, RefetchQueryFilters } from 'react-query';
import { PageSize } from '../../shared/components/document-pages/document-pages';

type ContextValue = {
    task?: Task;
    categories?: Category[];
    selectedCategory?: Category;
    selectedLink?: Link;
    selectedAnnotation?: Annotation;
    fileMetaInfo: FileMetaInfo;
    tokensByPages: Record<number, PageToken[]>;
    allAnnotations?: Record<number, Annotation[]>;
    pageNumbers: number[];
    currentPage: number;
    validPages: number[];
    invalidPages: number[];
    editedPages: number[];
    touchedPages: number[];
    modifiedPages: number[];
    pageSize?: { width: number; height: number };
    setPageSize: (pS: any) => void;
    tabValue: string;
    isOwner: boolean;
    sortedUsers: MutableRefObject<{ owners: User[]; annotators: User[]; validators: User[] }>;
    selectionType: AnnotationBoundType | AnnotationLinksBoundType | AnnotationImageToolType;
    selectedTool: AnnotationImageToolType;
    setSelectedTool: (t: AnnotationImageToolType) => void;
    onChangeSelectedTool: (t: AnnotationImageToolType) => void;
    tableMode: boolean;
    isNeedToSaveTable: {
        gutters: Maybe<TableGutterMap>;
        cells: Maybe<Annotation[]>;
    };
    setIsNeedToSaveTable: (b: {
        gutters: Maybe<TableGutterMap>;
        cells: Maybe<Annotation[]>;
    }) => void;
    isDataTabDisabled: boolean;
    isCategoryDataEmpty: boolean;
    annDataAttrs: Record<number, Array<CategoryDataAttributeWithValue>>;
    externalViewer: ExternalViewerState;
    onChangeSelectionType: (
        newType: AnnotationBoundType | AnnotationLinksBoundType | AnnotationImageToolType
    ) => void;
    onCategorySelected: (category: Category) => void;
    onLinkSelected: (link: Link) => void;
    onSaveTask: () => void;
    onExternalViewerClose: () => void;
    onAnnotationTaskFinish: () => void;
    onAnnotationCreated: (pageNum: number, annotation: Annotation) => void;
    onAnnotationDeleted: (pageNum: number, annotationId: string | number) => void;
    onAnnotationEdited: (
        pageNum: number,
        annotationId: string | number,
        changes: Partial<Annotation>
    ) => void;
    onLinkDeleted: (pageNum: number, annotationId: string | number, link: Link) => void;
    onCurrentPageChange: (page: number) => void;
    onValidClick: () => void;
    onInvalidClick: () => void;
    onEditClick: () => void;
    onCancelClick: () => void;
    onClearTouchedPages: () => void;
    onAddTouchedPage: () => void;
    onSaveEditClick: () => void;
    onEmptyAreaClick: () => void;
    onAnnotationDoubleClick: (annotation: Annotation) => void;
    onAnnotationClick: (annotation: Annotation) => void;
    onAnnotationCopyPress: (pageNum: number, annotationId: string | number) => void;
    onAnnotationCutPress: (pageNum: number, annotationId: string | number) => void;
    onAnnotationPastePress: (pageSize: PageSize, pageNum: number) => void;
    onAnnotationUndoPress: () => void;
    onAnnotationRedoPress: () => void;
    setTabValue: (value: string) => void;
    onDataAttributesChange: (elIndex: number, value: string) => void;
    tableCellCategory: string | number | undefined;
    setTableCellCategory: (s: string | number | undefined) => void;
    selectedToolParams: PaperToolParams;
    setSelectedToolParams: (nt: PaperToolParams) => void;
};

const TaskAnnotatorContext = createContext<ContextValue | undefined>(undefined);

type ProviderProps = {
    taskId?: number;
    fileMetaInfo?: FileMetaInfo;
    jobId?: number;
    revisionId?: string;
    onRedirectAfterFinish: () => void;
    onSaveTaskSuccess: () => void;
    onSaveTaskError: (error: ApiError) => void;
};

type UndoListAction = 'edit' | 'delete' | 'add';

const dataTabDefaultDisableState = true;

export const TaskAnnotatorContextProvider: FC<ProviderProps> = ({
    jobId,
    fileMetaInfo: fileMetaInfoParam,
    taskId,
    revisionId,
    onRedirectAfterFinish,
    onSaveTaskSuccess,
    onSaveTaskError,
    children
}) => {
    const [selectedCategory, setSelectedCategory] = useState<Category>();
    const [selectedLink, setSelectedLink] = useState<Link>();
    const [allAnnotations, setAllAnnotations] = useState<Record<number, Annotation[]>>({});

    const [copiedAnnotation, setCopiedAnnotation] = useState<Annotation>();
    const copiedAnnotationReference = useRef<Annotation | undefined>();
    copiedAnnotationReference.current = copiedAnnotation;

    const [undoList, setUndoList] = useState<
        { action: UndoListAction; annotation: Annotation; pageNumber: number }[]
    >([]);
    const [undoPointer, setUndoPointer] = useState<number>(-1);

    const [selectedToolParams, setSelectedToolParams] = useState<PaperToolParams>(
        {} as PaperToolParams
    );

    const [currentPage, setCurrentPage] = useState<number>(1);
    const [validPages, setValidPages] = useState<number[]>([]);
    const [invalidPages, setInvalidPages] = useState<number[]>([]);
    const [editedPages, setEditedPages] = useState<number[]>([]);
    const [touchedPages, setTouchedPages] = useState<number[]>([]);
    const [modifiedPages, setModifiedPages] = useState<number[]>([]);
    const [tabValue, setTabValue] = useState<string>('Categories');
    const [selectionType, setSelectionType] = useState<
        AnnotationBoundType | AnnotationLinksBoundType | AnnotationImageToolType
    >('free-box');
    const [selectedTool, setSelectedTool] = useState<AnnotationImageToolType>('pen');
    const [selectedAnnotation, setSelectedAnnotation] = useState<Annotation>();
    const [isDataTabDisabled, setIsDataTabDisabled] = useState<boolean>(dataTabDefaultDisableState);
    const [isCategoryDataEmpty, setIsCategoryDataEmpty] = useState<boolean>(false);
    const [annDataAttrs, setAnnDataAttrs] = useState<
        Record<number, Array<CategoryDataAttributeWithValue>>
    >({});
    const [externalViewer, setExternalViewer] =
        useState<ExternalViewerState>(defaultExternalViewer);

    const [tableMode, setTableMode] = useState<boolean>(false);
    const [tableCellCategory, setTableCellCategory] = useState<string | number | undefined>('');

    const [isNeedToSaveTable, setIsNeedToSaveTable] = useState<{
        gutters: Maybe<TableGutterMap>;
        cells: Maybe<Annotation[]>;
    }>({
        gutters: undefined,
        cells: undefined
    });

    const [storedParams, setStoredParams] = useState<{
        [k in typeof toolNames[number]]: Maybe<PaperToolParams>;
    }>({
        brush: undefined,
        dextr: undefined,
        eraser: undefined,
        pen: undefined,
        rectangle: undefined,
        select: undefined,
        wand: undefined
    });
    const defaultPageWidth: number = 0;
    const defaultPageHeight: number = 0;
    let fileMetaInfo: FileMetaInfo = fileMetaInfoParam!;

    const [pageSize, setPageSize] = useState<{ width: number; height: number }>({
        width: defaultPageWidth,
        height: defaultPageHeight
    });

    let task: Task | undefined;
    let isTaskLoading: boolean = false;
    let refetchTask: (
        options?: (RefetchOptions & RefetchQueryFilters<Task>) | undefined
    ) => Promise<QueryObserverResult<Task, unknown>>;
    if (taskId) {
        const result = useTaskById({ taskId }, {});
        task = result.data;
        isTaskLoading = result.isLoading;
        refetchTask = result.refetch;
    }

    const getJobId = (): number | undefined => (task ? task.job.id : jobId);

    const getFileId = (): number | undefined => (task ? task.file.id : fileMetaInfo?.id);

    const { isOwner, sortedUsers } = useUsersDataFromTask(task);

    let pageNumbers: number[] = [];

    if (task) {
        pageNumbers = task.pages;
    } else if (fileMetaInfo?.pages) {
        for (let i = 0; i < fileMetaInfo.pages; i++) {
            pageNumbers.push(i + 1);
        }
    }

    const categoriesResult = useCategoriesByJob({ jobId: getJobId() }, { enabled: false });

    const categories = categoriesResult.data?.data;

    const filters: Filter<keyof FileDocument>[] = [];

    filters.push({
        field: 'id',
        operator: Operators.EQ,
        value: getFileId()
    });
    const documentsResult = useDocuments(
        {
            filters
        },
        { enabled: false }
    );
    const latestAnnotationsResult = useLatestAnnotations(
        {
            jobId: getJobId(),
            fileId: getFileId(),
            revisionId,
            pageNumbers: pageNumbers
        },
        { enabled: !!(task || jobId) }
    );

    const tokenRes = useTokens(
        {
            fileId: getFileId(),
            pageNumbers: pageNumbers
        },
        { enabled: false }
    );
    const tokenPages = tokenRes.data;

    if (!fileMetaInfo) {
        fileMetaInfo = useMemo(
            () => ({
                ...documentSearchResultMapper(documentsResult.data),
                isLoading: isTaskLoading || documentsResult.isLoading
            }),
            [documentsResult.data, documentsResult.isLoading, isTaskLoading]
        );
    }

    useEffect(() => {
        if (task || jobId) {
            categoriesResult.refetch();
            setCurrentPage(pageNumbers[0]);
            documentsResult.refetch();
            latestAnnotationsResult.refetch();
            tokenRes.refetch();
        }
    }, [task, jobId]);

    const createAnnotation = (pageNum: number, newAnnotation: Annotation) => {
        const pageAnnotations = allAnnotations[pageNum] ?? [];

        setAllAnnotations((prevState) => ({
            ...prevState,
            [pageNum]: [
                ...pageAnnotations,
                {
                    ...newAnnotation,
                    color: selectedCategory?.metadata?.color,
                    label: selectedCategory?.name
                }
            ]
        }));

        setModifiedPages((prevState) => {
            return Array.from(new Set([...prevState, pageNum]));
        });
        setTableMode(newAnnotation.boundType === 'table');
        setSelectedAnnotation(newAnnotation);
        setIsDataTabDisabled(false);

        setAnnotationDataAttrs(newAnnotation);
    };

    const onAnnotationCreated = (pageNum: number, newAnnotation: Annotation) => {
        createAnnotation(pageNum, newAnnotation);

        updateUndoList(pageNum, cloneDeep(newAnnotation), 'add');
    };

    const deleteAnnotation = (pageNum: number, annotationId: string | number) => {
        const pageAnnotations = allAnnotations[pageNum] ?? [];
        const anntn: Maybe<Annotation> = pageAnnotations.find((el) => el.id === annotationId);
        setAllAnnotations((prevState) => {
            for (let k in prevState) {
                prevState[k].map((annList) =>
                    annList?.links?.filter((link) => link.to !== annotationId)
                );
            }
            return {
                ...prevState,
                [pageNum]: pageAnnotations.filter((ann) => {
                    if (
                        anntn &&
                        anntn.children &&
                        anntn.boundType === 'table' &&
                        (anntn.children as number[]).includes(+ann.id) &&
                        ann.boundType === 'table_cell'
                    ) {
                        return false;
                    }
                    return ann.id !== annotationId;
                })
            };
        });

        setModifiedPages((prevState) => {
            return Array.from(new Set([...prevState, pageNum]));
        });
    };

    const onAnnotationDeleted = (pageNum: number, annotationId: string | number) => {
        const annotationBeforeModification = allAnnotations[pageNum]?.find(
            (item) => item.id === annotationId
        );
        updateUndoList(pageNum, cloneDeep(annotationBeforeModification), 'delete');

        deleteAnnotation(pageNum, annotationId);
    };

    const onCategorySelected = (category: Category) => {
        setSelectedCategory(category);
    };

    const onLinkSelected = (link: Link) => {
        setSelectedLink(link);
    };

    const onChangeSelectionType = (
        newType: AnnotationBoundType | AnnotationLinksBoundType | AnnotationImageToolType
    ) => {
        setSelectionType(newType);
    };

    const onChangeSelectedTool = (newTool: AnnotationImageToolType) => {
        setSelectedTool(newTool);
        setSelectionType('polygon');
    };

    useEffect(() => {
        setStoredParams({
            ...storedParams,
            [selectedTool]: selectedToolParams
        });
    }, [selectedToolParams]);

    useEffect(() => {
        switch (selectedTool) {
            case 'eraser':
                if (storedParams.eraser) setSelectedToolParams(storedParams.eraser);
                else
                    setSelectedToolParams({
                        type: 'slider-number',
                        values: {
                            radius: { value: 40, bounds: { min: 0, max: 150 } }
                        }
                    });
                break;
            case 'brush':
                if (storedParams.brush) setSelectedToolParams(storedParams.brush);
                else
                    setSelectedToolParams({
                        type: 'slider-number',
                        values: {
                            radius: { value: 40, bounds: { min: 0, max: 150 } }
                        }
                    });
                break;
            case 'wand':
                if (storedParams.wand) setSelectedToolParams(storedParams.wand);
                else
                    setSelectedToolParams({
                        type: 'slider-number',
                        values: {
                            threshold: { value: 35, bounds: { min: 0, max: 150 } },
                            deviation: { value: 15, bounds: { min: 0, max: 150 } }
                        }
                    });
                break;
            case 'dextr':
            case 'rectangle':
            case 'select':
            case 'pen':
                break;
        }
    }, [selectedTool]);

    const onExternalViewerClose = () => setExternalViewer(defaultExternalViewer);

    const findAndSetExternalViewerType = (
        annDataAttrs: CategoryDataAttributeWithValue[] | undefined
    ) => {
        const foundExternalViewer = annDataAttrs?.find(({ type }) => isValidCategoryType(type));

        if (foundExternalViewer) {
            setExternalViewer({
                isOpen: true,
                type: foundExternalViewer.type,
                name: foundExternalViewer.name,
                value: foundExternalViewer.value
            });
        }
    };

    const onEmptyAreaClick = () => {
        setIsDataTabDisabled(dataTabDefaultDisableState);
        setAnnDataAttrs({});
        setIsCategoryDataEmpty(true);
        setTabValue('Categories');
    };

    const setAnnotationDataAttrs = (annotation: Annotation) => {
        const foundCategoryDataAttrs = getCategoryDataAttrs(
            annotation.label || annotation.category,
            categories
        );
        if (foundCategoryDataAttrs && foundCategoryDataAttrs.length) {
            setAnnDataAttrs((prevState) => {
                prevState[+annotation.id] = mapAnnDataAttrs(
                    foundCategoryDataAttrs,
                    prevState[+annotation.id]
                );
                return prevState;
            });
            setTabValue('Data');
            setIsCategoryDataEmpty(false);
            setSelectedAnnotation(annotation);
        } else {
            setTabValue('Categories');
            setIsCategoryDataEmpty(true);
            setSelectedAnnotation(undefined);
        }
        setIsDataTabDisabled(foundCategoryDataAttrs && foundCategoryDataAttrs.length === 0);
    };

    const onAnnotationClick = (annotation: Annotation) => {
        setAnnotationDataAttrs(annotation);
    };

    const onAnnotationCopyPress = (pageNum: number, annotationId: string | number) => {
        if (annotationId && pageNum) {
            const annotation = allAnnotations[pageNum].find((item) => item.id === annotationId);
            if (annotation) {
                setCopiedAnnotation(annotation);
            }
        }
    };

    const onAnnotationCutPress = (pageNum: number, annotationId: string | number) => {
        onAnnotationCopyPress(pageNum, annotationId);
        onAnnotationDeleted(pageNum, annotationId);
    };

    const onAnnotationPastePress = (pageSize: PageSize, pageNum: number) => {
        const annotationToPaste = copiedAnnotationReference.current;
        if (!annotationToPaste) {
            return;
        }

        const newAnnotation = cloneDeep(annotationToPaste);
        newAnnotation.bound.x = (pageSize?.width || 0) / 2 - newAnnotation.bound.width / 2;
        newAnnotation.bound.y = (pageSize?.height || 0) / 2 - newAnnotation.bound.height / 2;
        newAnnotation.id = Date.now();

        const pageAnnotations = allAnnotations[pageNum] ?? [];

        setAllAnnotations((prevState) => ({
            ...prevState,
            [pageNum]: [
                ...pageAnnotations,
                {
                    ...newAnnotation
                }
            ]
        }));
    };

    // swap annotation state and its saved state in undoList
    const swapAnnotationState = (
        pageNumber: number,
        annotationId: number | string,
        undoPointer: number
    ) => {
        const oldAnnotationState = cloneDeep(
            allAnnotations[pageNumber].find((item) => item.id === annotationId)
        );

        modifyAnnotation(pageNumber, annotationId, undoList[undoPointer].annotation);

        const undoListCopy = cloneDeep(undoList);
        undoListCopy[undoPointer].annotation = oldAnnotationState!;
        setUndoList(undoListCopy);
    };

    const onAnnotationUndoPress = () => {
        let undoPointerCopy = undoPointer;
        if (!undoList.length || undoPointerCopy === 0) {
            return;
        }
        if (undoPointerCopy === -1) {
            undoPointerCopy = undoList.length - 1; // set initial pointer position
        } else {
            undoPointerCopy--; // move pointer one step to the left
        }

        const annotationId = undoList[undoPointerCopy].annotation.id;
        const pageNumber = undoList[undoPointerCopy].pageNumber;

        switch (undoList[undoPointerCopy].action) {
            case 'edit':
                swapAnnotationState(pageNumber, annotationId, undoPointerCopy);
                break;

            case 'delete':
                createAnnotation(pageNumber, undoList[undoPointerCopy].annotation);
                break;

            case 'add':
                deleteAnnotation(pageNumber, annotationId);
                break;
        }

        setUndoPointer(undoPointerCopy);
    };

    const onAnnotationRedoPress = () => {
        if (!undoList.length || undoPointer === -1) {
            return;
        }

        const annotationId = undoList[undoPointer].annotation.id;
        const pageNumber = undoList[undoPointer].pageNumber;

        switch (undoList[undoPointer].action) {
            case 'edit':
                swapAnnotationState(pageNumber, annotationId, undoPointer);
                break;

            case 'delete':
                deleteAnnotation(pageNumber, annotationId);
                break;

            case 'add':
                createAnnotation(pageNumber, undoList[undoPointer].annotation);
                break;
        }

        const isUndoPointerAtListEnd = undoPointer >= undoList.length - 1;
        setUndoPointer(isUndoPointerAtListEnd ? -1 : undoPointer + 1); // move pointer one step to the right if possible
    };

    const onAnnotationDoubleClick = (annotation: Annotation) => {
        const { id, label } = annotation;

        if (annotation.boundType === 'table') {
            setTableMode(true);
            setTabValue('Data');
            setSelectedAnnotation(annotation);
            return;
        } else {
            setTableMode(false);
        }

        const foundCategoryDataAttrs = getCategoryDataAttrs(label, categories);

        if (foundCategoryDataAttrs) {
            setAnnDataAttrs((prevState) => {
                const mapAttributes = mapAnnDataAttrs(foundCategoryDataAttrs, prevState[+id]);

                findAndSetExternalViewerType(mapAttributes);
                prevState[+id] = mapAttributes;

                return prevState;
            });
            setIsCategoryDataEmpty(false);
            setSelectedAnnotation(annotation);
        } else {
            setIsCategoryDataEmpty(true);
            setSelectedAnnotation(undefined);
        }
    };

    const onDataAttributesChange = (elIndex: number, value: string) => {
        const newAnn = { ...annDataAttrs };

        if (selectedAnnotation) {
            const annItem = newAnn[+selectedAnnotation.id][elIndex];
            newAnn[+selectedAnnotation.id][elIndex].value = value;

            if (isValidCategoryType(annItem.type)) {
                setExternalViewer({
                    isOpen: true,
                    type: annItem.type,
                    name: annItem.name,
                    value
                });
            }

            setAnnDataAttrs(newAnn);
        }
    };

    const addAnnotationMutation = useAddAnnotationsMutation();

    const modifyAnnotation = (
        pageNum: number,
        id: string | number,
        changes: Partial<Annotation>
    ) => {
        setAllAnnotations((prevState) => {
            if (pageNum === -1) {
                pageNum = (Object.keys(prevState) as unknown as Array<number>).find((key: number) =>
                    prevState[key].find((ann) => ann.id == id)
                )!;
            }
            const pageAnnotations = prevState[pageNum] ?? [];
            return {
                ...prevState,
                [pageNum]: pageAnnotations.map((ann) => {
                    if (ann.id === id) {
                        return { ...ann, ...changes, id };
                    }
                    return ann;
                })
            };
        });
        setModifiedPages((prevState) => {
            return Array.from(new Set([...prevState, pageNum]));
        });
    };

    const onLinkDeleted = (pageNum: number, id: string | number, linkToDel: Link) => {
        setAllAnnotations((prevState) => {
            const pageAnnotations = prevState[pageNum] ?? [];
            return {
                ...prevState,
                [pageNum]: pageAnnotations.map((ann) => {
                    if (ann.id === id) {
                        return {
                            ...ann,
                            links: ann.links?.filter((link) => {
                                return (
                                    link.category_id !== linkToDel.category_id &&
                                    link.page_num !== linkToDel.page_num &&
                                    link.to !== linkToDel.to &&
                                    link.type !== linkToDel.type
                                );
                            })
                        };
                    }
                    return ann;
                })
            };
        });
    };

    const updateUndoList = (
        pageNum: number,
        annotationBeforeModification: Annotation | undefined,
        action: UndoListAction
    ) => {
        if (!annotationBeforeModification) {
            return;
        }
        const undoListCopy = cloneDeep(undoList);
        if (undoPointer !== -1) {
            undoListCopy.splice(undoPointer); // delete everything from pointer (including) to the right
            setUndoPointer(-1);
        }
        setUndoList([
            ...undoListCopy,
            { action, annotation: annotationBeforeModification, pageNumber: pageNum }
        ]);
    };

    const onAnnotationEdited = (
        pageNum: number,
        annotationId: string | number,
        changes: Partial<Annotation>
    ) => {
        const annotationBeforeModification = allAnnotations[pageNum]?.find(
            (item) => item.id === annotationId
        );
        updateUndoList(pageNum, cloneDeep(annotationBeforeModification), 'edit');
        modifyAnnotation(pageNum, annotationId, changes);
    };
    const onCloseDataTab = () => {
        setTabValue('Categories');
        setIsDataTabDisabled(true);
        onExternalViewerClose();
    };
    const onSaveTask = async () => {
        if (!task || !latestAnnotationsResult.data) return;

        let { revision, pages } = latestAnnotationsResult.data;

        onCloseDataTab();

        if (task.is_validation) {
            pages = pages.filter(
                (page) => validPages.includes(page.page_num) || invalidPages.includes(page.page_num)
            );
        } else {
            pages = mapModifiedAnnotationPagesToApi(
                modifiedPages,
                allAnnotations,
                tokensByPages,
                tokenPages?.length ? tokenPages : pages,
                annDataAttrs,
                pageSize
            );
        }

        if (!taskId) {
            return;
        }

        try {
            await addAnnotationMutation.mutateAsync({
                taskId,
                pages,
                userId: task.user_id,
                revision,
                validPages,
                invalidPages
            });
            onSaveTaskSuccess();
            latestAnnotationsResult.refetch();
            refetchTask();
        } catch (error) {
            onSaveTaskError(error as ApiError);
        }
    };

    const onAnnotationTaskFinish = () => {
        if (task) {
            onSaveTask().then((e) => {
                useSetTaskFinished(task!.id);
                onRedirectAfterFinish();
            });
        }
    };

    const onCurrentPageChange = (page: number) => {
        setCurrentPage(page);
    };

    useEffect(() => {
        if (!latestAnnotationsResult.data || !categories) return;
        setValidPages(latestAnnotationsResult.data.validated);
        setInvalidPages(latestAnnotationsResult.data.failed_validation_pages);

        const result = mapAnnotationPagesFromApi(latestAnnotationsResult.data.pages, categories);
        setAllAnnotations(result);

        const annDataAttrsResult = mapAnnotationDataAttrsFromApi(
            latestAnnotationsResult.data.pages
        );
        setAnnDataAttrs(annDataAttrsResult);

        if (
            latestAnnotationsResult.data.pages.length === 0 ||
            !latestAnnotationsResult.data.pages[0].size ||
            latestAnnotationsResult.data.pages[0].size.width === 0 ||
            latestAnnotationsResult.data.pages[0].size.height === 0
        )
            return;
        setPageSize(latestAnnotationsResult.data.pages[0].size);
    }, [latestAnnotationsResult.data, categories]);

    const onValidClick = useCallback(() => {
        if (invalidPages.includes(currentPage)) {
            const newInvalidPages = invalidPages.filter((page) => page !== currentPage);
            setInvalidPages(newInvalidPages);
        }
        setValidPages([...validPages, currentPage]);
    }, [invalidPages, validPages, currentPage]);

    const onInvalidClick = useCallback(() => {
        if (validPages.includes(currentPage)) {
            const newValidPages = validPages.filter((page) => page !== currentPage);
            setValidPages(newValidPages);
        }
        setInvalidPages([...invalidPages, currentPage]);
    }, [invalidPages, validPages, currentPage]);

    const onClearTouchedPages = useCallback(async () => {
        setTouchedPages([]);
    }, []);

    const onAddTouchedPage = useCallback(() => {
        !touchedPages.includes(currentPage)
            ? setTouchedPages([...touchedPages, currentPage])
            : () => {};
    }, [touchedPages, currentPage]);

    const onEditClick = useCallback(() => {
        setEditedPages([...editedPages, currentPage]);
        if (invalidPages.includes(currentPage)) {
            const newInvalidPages = invalidPages.filter((page) => page !== currentPage);
            setInvalidPages(newInvalidPages);
        }
    }, [editedPages, invalidPages, currentPage]);

    const onCancelClick = useCallback(() => {
        onCloseDataTab();

        if (editedPages.includes(currentPage)) {
            const newEditedPages = editedPages.filter((page) => page !== currentPage);
            setEditedPages(newEditedPages);
        }
        setInvalidPages([...invalidPages, currentPage]);
    }, [editedPages, invalidPages, currentPage]);

    const onSaveEditClick = useCallback(async () => {
        if (!task || !latestAnnotationsResult.data || !tokenPages) return;

        let { revision } = latestAnnotationsResult.data;
        const pages = mapModifiedAnnotationPagesToApi(
            editedPages,
            allAnnotations,
            tokensByPages,
            tokenPages,
            annDataAttrs,
            pageSize
        );

        onCloseDataTab();

        if (!taskId) {
            return;
        }

        try {
            await addAnnotationMutation.mutateAsync({
                taskId,
                pages,
                userId: task.user_id,
                revision,
                validPages,
                invalidPages
            });
            onCancelClick();
            onSaveTaskSuccess();

            latestAnnotationsResult.refetch();
        } catch (error) {
            onSaveTaskError(error as ApiError);
        }
    }, [allAnnotations, editedPages, currentPage]);

    const tokensByPages = useMemo<Record<number, PageToken[]>>(() => {
        if (!tokenPages?.length) {
            return {};
        }
        const tokenScale =
            pageSize && tokenPages[0].size && tokenPages[0].size.width
                ? pageSize.width / tokenPages[0].size?.width!
                : 1;
        return mapTokenPagesFromApi(tokenPages, tokenScale);
    }, [tokenPages, pageSize]);

    const value = useMemo<ContextValue>(() => {
        return {
            task,
            categories,
            selectedCategory,
            selectedLink,
            fileMetaInfo,
            tokensByPages,
            allAnnotations,
            pageNumbers,
            currentPage,
            validPages,
            invalidPages,
            pageSize,
            setPageSize,
            editedPages,
            touchedPages,
            modifiedPages,
            selectionType,
            selectedTool,
            setSelectedTool,
            selectedToolParams,
            setSelectedToolParams,
            onChangeSelectedTool,
            tableMode,
            isNeedToSaveTable,
            setIsNeedToSaveTable,
            tabValue,
            selectedAnnotation,
            sortedUsers,
            isOwner,
            isDataTabDisabled,
            isCategoryDataEmpty,
            annDataAttrs,
            externalViewer,
            tableCellCategory,
            setTableCellCategory,
            onAnnotationCreated,
            onAnnotationDeleted,
            onAnnotationEdited,
            onLinkDeleted,
            onCategorySelected,
            onLinkSelected,
            onChangeSelectionType,
            onSaveTask,
            onAnnotationTaskFinish,
            onCurrentPageChange,
            onValidClick,
            onInvalidClick,
            onEditClick,
            onAddTouchedPage,
            onClearTouchedPages,
            onCancelClick,
            onSaveEditClick,
            setTabValue,
            onDataAttributesChange,
            onEmptyAreaClick,
            onAnnotationClick,
            onAnnotationDoubleClick,
            onAnnotationCopyPress,
            onAnnotationCutPress,
            onAnnotationPastePress,
            onAnnotationUndoPress,
            onAnnotationRedoPress,
            onExternalViewerClose
        };
    }, [
        task,
        categories,
        selectedCategory,
        selectedLink,
        selectionType,
        selectedTool,
        fileMetaInfo,
        tokensByPages,
        allAnnotations,
        currentPage,
        validPages,
        invalidPages,
        touchedPages,
        pageSize,
        tableMode,
        isNeedToSaveTable,
        tabValue,
        selectedAnnotation,
        annDataAttrs,
        externalViewer,
        tableCellCategory,
        isDataTabDisabled,
        selectedToolParams
    ]);

    return <TaskAnnotatorContext.Provider value={value}>{children}</TaskAnnotatorContext.Provider>;
};

export const useTaskAnnotatorContext = () => {
    const context = useContext(TaskAnnotatorContext);

    if (context === undefined) {
        throw new Error(
            `useTaskAnnotatorContext must be used within a TaskAnnotatorContextProvider`
        );
    }
    return context;
};
